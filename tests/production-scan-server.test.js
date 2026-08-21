"use strict";

const http = require("http");
const { createProductionScanServer, normalizeCloudResponse } = require("../production/scan-server");

const fakeConfig = {
  endpoint_url: "https://example.invalid/receiveRoomScanEvent",
  room_id: "room-1",
  station_id: "station-1",
  device_id: "device-1",
  location_id: "location-1",
};
const fakeSecrets = { shared_secret: "fake-shared-secret" };

function scan() {
  return {
    event_id: "fake-event-id",
    visit_id: "fake-visit",
    raw_scan_value: "fake-patient-barcode",
    location_id: "location-1",
    room_id: "room-1",
    station_id: "station-1",
    device_id: "device-1",
    event_type: "scan_received",
    source_type: "PI_SCANNER",
    device_timestamp_utc: new Date().toISOString(),
  };
}

function request(server, method, path, body) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path,
        method,
        agent: false,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
              Connection: "close",
            }
          : { Connection: "close" },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(raw) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(payload);
    req.end();
  });
}

async function makeServer({
  cloudRequest,
  controllerStateRequest = jest.fn().mockResolvedValue(200),
  config = fakeConfig,
  secrets = fakeSecrets,
  logger = () => {},
} = {}) {
  const api = createProductionScanServer({
    configStore: { readConfig: () => config },
    secretsStore: { readSecrets: () => secrets },
    cloudRequest,
    controllerStateRequest,
    logger,
    port: 0,
  });
  return await new Promise((resolve) => {
    const server = api.start(() => resolve(server));
  });
}

describe("production scan API", () => {
  let server;

  afterEach(async () => {
    jest.useRealTimers();
    const activeServer = server;
    server = null;
    if (!activeServer || !activeServer.listening) return;
    await new Promise((resolve, reject) => {
      activeServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test.each([
    ["accepted", { statusCode: 200, body: { ok: true } }, "accepted", false],
    ["rejected", { statusCode: 400, body: { ok: false } }, "rejected", false],
    ["duplicate", { statusCode: 200, body: { duplicate: true } }, "duplicate", true],
  ])("normalizes cloud %s response", async (_name, cloud, disposition, duplicate) => {
    server = await makeServer({ cloudRequest: jest.fn().mockResolvedValue(cloud) });
    const response = await request(server, "POST", "/api/scan", scan());
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ disposition, duplicate });
  });

  test("returns unavailable when starting without complete configuration", async () => {
    server = await makeServer({ config: {}, secrets: {} });
    const status = await request(server, "GET", "/api/status");
    expect(status.body).toMatchObject({ ok: false, state: "starting" });
    const response = await request(server, "POST", "/api/scan", scan());
    expect(response.statusCode).toBe(503);
    expect(response.body.disposition).toBe("unavailable");
  });

  test("reports healthy when production configuration and secret are available", async () => {
    server = await makeServer({ cloudRequest: jest.fn() });
    const status = await request(server, "GET", "/api/status");
    expect(status.body).toEqual({
      ok: true,
      service: "multimedica-production",
      state: "healthy",
    });
  });

  test("returns unavailable for cloud timeout or failure without logging scan or secret", async () => {
    const logs = [];
    server = await makeServer({
      cloudRequest: jest.fn().mockRejectedValue(new Error("fake cloud timeout")),
      logger: (message) => logs.push(message),
    });
    const response = await request(server, "POST", "/api/scan", scan());
    const output = JSON.stringify({ logs, response: response.body });
    expect(response.statusCode).toBe(503);
    expect(response.body.disposition).toBe("unavailable");
    expect(output).not.toContain("fake-patient-barcode");
    expect(output).not.toContain("fake-shared-secret");
  });

  test("rejects malformed scan requests without forwarding", async () => {
    const cloudRequest = jest.fn();
    server = await makeServer({ cloudRequest });
    cloudRequest.mockClear();
    const response = await request(server, "POST", "/api/scan", { event_id: "x" });
    expect(response.statusCode).toBe(200);
    expect(response.body.disposition).toBe("rejected");
    expect(cloudRequest).not.toHaveBeenCalled();
  });

  test("normalization treats malformed cloud response as rejected", () => {
    expect(normalizeCloudResponse(null)).toMatchObject({ disposition: "rejected" });
  });

  test("normalizes waiting, in-process, available, and closed cloud display states", () => {
    for (const code of ["patient_waiting", "in_process", "available", "closed"]) {
      const normalized = normalizeCloudResponse({
        statusCode: 200,
        body: {
          ok: true,
          state: { mode: code === "closed" ? "closed" : "room_status", status: { code } },
        },
      });
      expect(normalized.runtime_state).toMatchObject({ kind: "room" });
      expect(normalized.runtime_state.state_id).toMatch(/^cloud-/);
    }
  });

  test("wrapped closed state is a closed-priority room state", () => {
    const normalized = normalizeCloudResponse({
      statusCode: 200,
      body: { ok: true, state: { state: { mode: "closed", status: { code: "closed" } } } },
    });
    expect(normalized.runtime_state).toMatchObject({ kind: "room", priority: "closed" });
  });

  test("scan response does not duplicate-deliver its runtime state to controller", async () => {
    const controllerStateRequest = jest.fn().mockResolvedValue(200);
    const cloudRequest = jest
      .fn()
      .mockResolvedValueOnce({
        statusCode: 200,
        body: { ok: true, state: { mode: "room_status", status: { code: "available" } } },
      })
      .mockResolvedValueOnce({ statusCode: 200, body: { ok: true } });
    server = await makeServer({ cloudRequest, controllerStateRequest });
    await new Promise((resolve) => setImmediate(resolve));
    controllerStateRequest.mockClear();
    await request(server, "POST", "/api/scan", scan());
    expect(controllerStateRequest).not.toHaveBeenCalled();
  });

  test("polling rereads changed config and shared secret", async () => {
    jest.useFakeTimers();
    let currentConfig = { ...fakeConfig };
    let currentSecrets = { ...fakeSecrets };
    const cloudRequest = jest
      .fn()
      .mockResolvedValue({
        statusCode: 200,
        body: { ok: true, polling: { should_poll: true, recommended_interval_ms: 1000 } },
      });
    const api = createProductionScanServer({
      configStore: { readConfig: () => currentConfig },
      secretsStore: { readSecrets: () => currentSecrets },
      cloudRequest,
      controllerStateRequest: jest.fn().mockResolvedValue(200),
      port: 0,
    });
    server = await new Promise((resolve) => {
      const item = api.start(() => resolve(item));
    });
    await Promise.resolve();
    currentConfig = { ...currentConfig, endpoint_url: "https://new.invalid/receiveRoomScanEvent" };
    currentSecrets = { shared_secret: "new-fake-secret" };
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(cloudRequest.mock.calls.at(-1)).toEqual(
      expect.arrayContaining([
        "https://new.invalid/syncStationDisplayState",
        expect.any(Object),
        "new-fake-secret",
      ])
    );
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    expect(jest.getTimerCount()).toBe(0);
    server = null;
  });

  test("boot sync delivers normalized state through controller loopback", async () => {
    const controllerStateRequest = jest.fn().mockResolvedValue(200);
    const cloudRequest = jest.fn().mockResolvedValue({
      statusCode: 200,
      body: {
        ok: true,
        state: { mode: "closed", status: { code: "closed", label: "CERRADO" } },
        polling: { should_poll: true, recommended_interval_ms: 1_000 },
      },
    });
    server = await makeServer({ cloudRequest, controllerStateRequest });
    await new Promise((resolve) => setImmediate(resolve));
    expect(controllerStateRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "room", priority: "closed" })
    );
  });

  test("network failure sends a degraded runtime overlay to the controller", async () => {
    const controllerStateRequest = jest.fn().mockResolvedValue(200);
    server = await makeServer({
      cloudRequest: jest.fn().mockRejectedValue(new Error("network down")),
      controllerStateRequest,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(controllerStateRequest).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "overlay", priority: "network" })
    );
  });
});
