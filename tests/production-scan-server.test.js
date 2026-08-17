"use strict";

const http = require("http");
const {
  createProductionScanServer,
  normalizeCloudResponse,
} = require("../production/scan-server");

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
      },
    );
    req.on("error", reject);
    if (body) req.write(payload);
    req.end();
  });
}

async function makeServer({ cloudRequest, config = fakeConfig, secrets = fakeSecrets, logger = () => {} } = {}) {
  const api = createProductionScanServer({
    configStore: { readConfig: () => config },
    secretsStore: { readSecrets: () => secrets },
    cloudRequest,
    logger,
    port: 0,
  });
  return await new Promise((resolve) => {
    const server = api.start(() => resolve(server));
  });
}

describe("production scan API", () => {
  let server;

  afterEach((done) => {
    if (server) server.close(done);
    else done();
    server = null;
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
    const response = await request(server, "POST", "/api/scan", { event_id: "x" });
    expect(response.statusCode).toBe(200);
    expect(response.body.disposition).toBe("rejected");
    expect(cloudRequest).not.toHaveBeenCalled();
  });

  test("normalization treats malformed cloud response as rejected", () => {
    expect(normalizeCloudResponse(null)).toMatchObject({ disposition: "rejected" });
  });
});
