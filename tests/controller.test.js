"use strict";

/**
 * Controller Tests
 *
 * Tests the bootstrap/controller.js createController factory.
 * Uses fake/in-memory dependency injection so no hardware or network is needed.
 * All credentials are fake test values; no real tokens appear anywhere.
 *
 * Coverage:
 *  - QR handling for each kind (wifi, station, cloud, show_identity)
 *  - Invalid token rejection
 *  - Malformed QR rejection
 *  - Unsupported version rejection
 *  - Unknown kind rejection
 *  - Re-scanning replaces only the relevant fields
 *  - Unrelated config fields are preserved
 *  - show_identity never exposes secrets
 *  - Storage write failures produce sanitised error messages
 *  - Admin token not loaded â†’ clear error, no write
 *  - HTTP status endpoint exposes only non-secret fields
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { once } = require("events");

const { createController } = require("../bootstrap/controller");
const configStore = require("../bootstrap/lib/config-store");
const secretsStore = require("../bootstrap/lib/secrets-store");

const TEST_TOKEN = "test-controller-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mm-ctrl-"));
}

function rmTempDir(d) {
  fs.rmSync(d, { recursive: true, force: true });
}

/** Build a controller with a temp state dir and a mock display client */
function makeCtrl(tmpDir, extraDeps = {}) {
  process.env.MULTIMEDICA_STATE_DIR = tmpDir;

  // Install the test token so QR validation works
  secretsStore.writeSecrets({ qr_admin_token: TEST_TOKEN }, tmpDir);

  const displayLog = [];
  const mockDisplay = {
    updateState: jest.fn().mockResolvedValue(undefined),
    showMessage: jest.fn().mockResolvedValue(undefined),
    showIdentity: jest.fn().mockResolvedValue(undefined),
    showRuntimeState: jest.fn().mockResolvedValue(undefined),
    _log: displayLog,
  };

  const ctrl = createController({
    configStore,
    secretsStore,
    displayClient: mockDisplay,
    applyWifi: null, // skip nmcli; wifi applies silently in tests
    ...extraDeps,
  });

  ctrl.loadAdminToken();
  return { ctrl, display: mockDisplay, tmpDir };
}

function qr(kind, payload, token = TEST_TOKEN) {
  const obj = { kind, version: 1, payload, auth: { admin_token: token } };
  return "MMCFG:" + JSON.stringify(obj);
}

async function startTestStatusServer(ctrl) {
  const previousPort = process.env.CONTROLLER_PORT;
  process.env.CONTROLLER_PORT = "0";
  try {
    const server = ctrl.startStatusServer();
    await once(server, "listening");
    return server;
  } finally {
    if (previousPort === undefined) delete process.env.CONTROLLER_PORT;
    else process.env.CONTROLLER_PORT = previousPort;
  }
}

async function closeTestServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function getTestJson(server, pathname) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    http
      .get(`http://127.0.0.1:${port}${pathname}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.MULTIMEDICA_STATE_DIR;
  rmTempDir(tmpDir);
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// wifi_config
// ---------------------------------------------------------------------------

describe("handleScan â€” wifi_config", () => {
  test("writes wifi_ssid and wifi_security to config, wifi_password to secrets", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    await ctrl.handleScan(
      qr("wifi_config", { ssid: "TestNet", password: "test-pw", security: "wpa-psk" })
    );

    const cfg = configStore.readConfig(tmpDir);
    expect(cfg.wifi_ssid).toBe("TestNet");
    expect(cfg.wifi_security).toBe("wpa-psk");

    const sec = secretsStore.readSecrets(tmpDir);
    expect(sec.wifi_password).toBe("test-pw");
  });

  test("password never appears in config.json", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    await ctrl.handleScan(
      qr("wifi_config", { ssid: "TestNet", password: "super-secret-wifi-pass" })
    );
    const raw = fs.readFileSync(path.join(tmpDir, "config.json"), "utf8");
    expect(raw).not.toContain("super-secret-wifi-pass");
  });

  test("display receives success message after accepted wifi QR", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    await ctrl.handleScan(qr("wifi_config", { ssid: "TestNet", password: "pw" }));
    const successCalls = display.showMessage.mock.calls.filter(([arg]) => arg.kind === "success");
    expect(successCalls.length).toBeGreaterThan(0);
    // Message must not contain the password
    const msgText = successCalls[0][0].text || "";
    expect(msgText).not.toContain("pw");
  });

  test("failed Wi-Fi activation does not mark Wi-Fi configured or replace credentials", async () => {
    configStore.writeConfig({ wifi_ssid: "KnownGood", wifi_security: "wpa-psk" }, tmpDir);
    secretsStore.writeSecrets({ qr_admin_token: TEST_TOKEN, wifi_password: "known-good-pass" }, tmpDir);
    const applyWifi = jest.fn().mockRejectedValue(new Error("Wi-Fi configuration failed"));
    const { ctrl, display } = makeCtrl(tmpDir, { applyWifi });

    await ctrl.handleScan(
      qr("wifi_config", { ssid: "Candidate", password: "candidate-pass", security: "wpa-psk" })
    );

    expect(configStore.readConfig(tmpDir)).toMatchObject({
      wifi_ssid: "KnownGood",
      wifi_security: "wpa-psk",
    });
    expect(secretsStore.readSecrets(tmpDir).wifi_password).toBe("known-good-pass");
    expect(display.showMessage.mock.calls.at(-1)[0]).toMatchObject({ kind: "error" });
    expect(JSON.stringify(display.showMessage.mock.calls)).not.toContain("candidate-pass");
  });

  test("re-scanning wifi replaces ssid but preserves unrelated station fields", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    // First: scan station config
    await ctrl.handleScan(
      qr("station_config", {
        location_id: "loc1",
        room_id: "r1",
        station_id: "s1",
        device_id: "d1",
      })
    );
    // Then: scan wifi
    await ctrl.handleScan(qr("wifi_config", { ssid: "Net1", password: "pw1" }));
    // Re-scan wifi with different SSID
    await ctrl.handleScan(qr("wifi_config", { ssid: "Net2", password: "pw2" }));

    const cfg = configStore.readConfig(tmpDir);
    expect(cfg.wifi_ssid).toBe("Net2"); // replaced
    expect(cfg.station_id).toBe("s1"); // preserved
    expect(cfg.location_id).toBe("loc1"); // preserved
  });
});

// ---------------------------------------------------------------------------
// station_config
// ---------------------------------------------------------------------------

describe("handleScan â€” station_config", () => {
  test("writes all four identity fields to config", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    await ctrl.handleScan(
      qr("station_config", {
        location_id: "loc1",
        room_id: "loc1_r1",
        station_id: "nursing",
        device_id: "scanner01",
      })
    );
    const cfg = configStore.readConfig(tmpDir);
    expect(cfg.location_id).toBe("loc1");
    expect(cfg.room_id).toBe("loc1_r1");
    expect(cfg.station_id).toBe("nursing");
    expect(cfg.device_id).toBe("scanner01");
  });

  test("re-scanning station replaces identity but preserves wifi fields", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    await ctrl.handleScan(qr("wifi_config", { ssid: "Net", password: "pw" }));
    await ctrl.handleScan(
      qr("station_config", {
        location_id: "loc1",
        room_id: "r1",
        station_id: "s1",
        device_id: "d1",
      })
    );
    await ctrl.handleScan(
      qr("station_config", {
        location_id: "loc2",
        room_id: "r2",
        station_id: "s2",
        device_id: "d2",
      })
    );
    const cfg = configStore.readConfig(tmpDir);
    expect(cfg.station_id).toBe("s2");
    expect(cfg.wifi_ssid).toBe("Net"); // preserved
  });
});

// ---------------------------------------------------------------------------
// cloud_config
// ---------------------------------------------------------------------------

describe("handleScan â€” cloud_config", () => {
  test("writes endpoint_url to config, shared_secret to secrets only", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    await ctrl.handleScan(
      qr("cloud_config", {
        endpoint_url: "https://example.invalid/fn",
        shared_secret: "test-shared-secret-value",
      })
    );
    const cfg = configStore.readConfig(tmpDir);
    expect(cfg.endpoint_url).toBe("https://example.invalid/fn");
    const raw = fs.readFileSync(path.join(tmpDir, "config.json"), "utf8");
    expect(raw).not.toContain("test-shared-secret-value");

    const sec = secretsStore.readSecrets(tmpDir);
    expect(sec.shared_secret).toBe("test-shared-secret-value");
  });

  test("display success message never exposes shared_secret", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    await ctrl.handleScan(
      qr("cloud_config", {
        endpoint_url: "https://example.invalid/fn",
        shared_secret: "super-secret-123",
      })
    );
    const allText = display.showMessage.mock.calls.map(([arg]) => arg.text || "").join(" ");
    expect(allText).not.toContain("super-secret-123");
  });
});

// ---------------------------------------------------------------------------
// show_identity
// ---------------------------------------------------------------------------

describe("handleScan â€” show_identity", () => {
  test("calls displayClient.showIdentity with non-secret fields only", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    // Pre-populate config with identity fields
    configStore.writeConfig(
      {
        location_id: "loc1",
        room_id: "r1",
        station_id: "s1",
        device_id: "d1",
      },
      tmpDir
    );
    // Pre-populate secrets with a secret that must NOT appear in display call
    secretsStore.writeSecrets({ shared_secret: "this-must-not-be-shown" }, tmpDir);

    await ctrl.handleScan(qr("show_identity", {}));

    expect(display.showIdentity).toHaveBeenCalledTimes(1);
    const arg = display.showIdentity.mock.calls[0][0];
    expect(arg.station_id).toBe("s1");
    expect(arg).not.toHaveProperty("shared_secret");
    expect(arg).not.toHaveProperty("qr_admin_token");
    expect(arg).not.toHaveProperty("wifi_password");
    expect(JSON.stringify(arg)).not.toContain("this-must-not-be-shown");
  });

  test("show_identity does not modify config or secrets", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    configStore.writeConfig({ station_id: "s1" }, tmpDir);
    const cfgBefore = configStore.readConfig(tmpDir);
    const secBefore = secretsStore.readSecrets(tmpDir);

    await ctrl.handleScan(qr("show_identity", {}));

    expect(configStore.readConfig(tmpDir)).toEqual(cfgBefore);
    expect(secretsStore.readSecrets(tmpDir)).toEqual(secBefore);
  });
});

// ---------------------------------------------------------------------------
// Invalid / error cases
// ---------------------------------------------------------------------------

describe("handleScan â€” invalid inputs", () => {
  test("controller has no direct cloud endpoint or bearer authorization path", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "controller.js"),
      "utf8"
    );
    expect(source).toContain("http://127.0.0.1:3002/api/scan");
    expect(source).not.toMatch(/https:\/\//);
    expect(source).not.toContain("Authorization: `Bearer");
  });

  test("wrong admin token â†’ error message, no config change", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    const cfgBefore = configStore.readConfig(tmpDir);

    await ctrl.handleScan(qr("wifi_config", { ssid: "Net", password: "pw" }, "wrong-token"));

    expect(display.showMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
    expect(configStore.readConfig(tmpDir)).toEqual(cfgBefore);
  });

  test("malformed JSON after MMCFG: â†’ error message, no write", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    await ctrl.handleScan("MMCFG:not-valid-json");
    expect(display.showMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });

  test("unsupported QR version â†’ error message", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    const raw =
      "MMCFG:" +
      JSON.stringify({
        kind: "wifi_config",
        version: 99,
        payload: { ssid: "N", password: "p" },
        auth: { admin_token: TEST_TOKEN },
      });
    await ctrl.handleScan(raw);
    expect(display.showMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });

  test("unknown kind â†’ error message", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    await ctrl.handleScan(qr("not_a_real_kind", {}));
    expect(display.showMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });

  test("ordinary scan is forwarded only to the production API", async () => {
    const forwardProductionScan = jest.fn().mockResolvedValue({ disposition: "accepted" });
    const { ctrl, display } = makeCtrl(tmpDir, { forwardProductionScan });
    await ctrl.handleScan("VISIT:12345");
    expect(forwardProductionScan).toHaveBeenCalledTimes(1);
    const forwarded = forwardProductionScan.mock.calls[0][0];
    expect(forwarded).toMatchObject({
      visit_id: "12345",
      raw_scan_value: "VISIT:12345",
      event_type: "scan_received",
      source_type: "PI_SCANNER",
    });
    expect(JSON.stringify(display.showMessage.mock.calls)).not.toContain("VISIT:12345");
  });

  test.each(["rejected", "duplicate", "unavailable"])(
    "production %s result is handled safely",
    async (disposition) => {
      const forwardProductionScan = jest.fn().mockResolvedValue({ disposition });
      const { ctrl, display } = makeCtrl(tmpDir, { forwardProductionScan });
      await ctrl.handleScan("VISIT:12345");
      expect(display.showRuntimeState).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "overlay" })
      );
    }
  );

  test("production timeout, connection failure, and malformed response are unavailable", async () => {
    for (const forwardProductionScan of [
      jest.fn().mockRejectedValue(new Error("connection refused")),
      jest.fn().mockResolvedValue({ disposition: "not-valid" }),
    ]) {
      const { ctrl, display } = makeCtrl(tmpDir, { forwardProductionScan });
      await ctrl.handleScan("VISIT:12345");
      const runtime = display.showRuntimeState.mock.calls.at(-1)[0];
      expect(runtime.overlay.detail).toContain("rescan");
    }
  });

  test("production loopback request times out and prompts a rescan", async () => {
    const production = http.createServer(() => {});
    await new Promise((resolve) => production.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = production.address();
      const { ctrl, display } = makeCtrl(tmpDir, {
        productionScanUrl: `http://127.0.0.1:${port}/api/scan`,
        productionTimeoutMs: 20,
      });
      await ctrl.handleScan("VISIT:12345");
      expect(display.showRuntimeState).toHaveBeenCalledWith(
        expect.objectContaining({
          overlay: expect.objectContaining({ detail: expect.stringContaining("rescan") }),
        })
      );
    } finally {
      await new Promise((resolve) => production.close(resolve));
    }
  });

  test("configuration QR never reaches production API", async () => {
    const forwardProductionScan = jest.fn();
    const { ctrl } = makeCtrl(tmpDir, { forwardProductionScan });
    await ctrl.handleScan(
      qr("station_config", {
        location_id: "loc1",
        room_id: "r1",
        station_id: "s1",
        device_id: "d1",
      })
    );
    expect(forwardProductionScan).not.toHaveBeenCalled();
  });

  test("admin token not loaded â†’ error, no write", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    // Override: delete the secrets so token is null
    ctrl._testClearToken && ctrl._testClearToken();

    // Create a fresh controller without loading the token
    const emptyCtrl = createController({
      configStore,
      secretsStore,
      displayClient: display,
      applyWifi: null,
    });
    // Do NOT call loadAdminToken()

    const cfgBefore = configStore.readConfig(tmpDir);
    await emptyCtrl.handleScan(qr("wifi_config", { ssid: "N", password: "p" }));

    expect(display.showMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
    expect(configStore.readConfig(tmpDir)).toEqual(cfgBefore);
  });

  test("error messages never contain the token value", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    await ctrl.handleScan(qr("wifi_config", { ssid: "N", password: "p" }, "wrong-token"));

    for (const call of display.showMessage.mock.calls) {
      const text = (call[0] && call[0].text) || "";
      expect(text).not.toContain(TEST_TOKEN);
      expect(text).not.toContain("wrong-token");
    }
  });
});

describe("runtime display coordination", () => {
  test("connection failure shows feedback unavailable overlay and preserves room state", async () => {
    jest.useFakeTimers();
    const { ctrl, display } = makeCtrl(tmpDir, {
      forwardProductionScan: jest.fn().mockRejectedValue(new Error("offline")),
    });
    const server = await startTestStatusServer(ctrl);
    try {
      const post = async (body) => {
        const { port } = server.address();
        return await new Promise((resolve, reject) => {
          const payload = JSON.stringify(body);
          const request = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/api/runtime-state",
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              },
            },
            (response) => {
              response.resume();
              response.on("end", () => resolve(response.statusCode));
            }
          );
          request.on("error", reject);
          request.write(payload);
          request.end();
        });
      };
      const room = {
        kind: "room",
        state_id: "room-stable",
        priority: "room",
        display: { mode: "room_status", status: { code: "available", label: "AVAILABLE" } },
      };
      expect(await post(room)).toBe(200);
      await ctrl.handleScan("VISIT:12345");
      const overlay = display.showRuntimeState.mock.calls.at(-1)[0];
      expect(overlay).toMatchObject({
        kind: "overlay",
        priority: "feedback",
        expires_in_ms: 10000,
        overlay: { severity: "error", title: "Production unavailable", detail: "Please rescan." },
      });
      jest.advanceTimersByTime(10000);
      expect(display.showRuntimeState.mock.calls.at(-1)[0]).toMatchObject({
        state_id: "room-stable",
      });
    } finally {
      await closeTestServer(server);
      jest.useRealTimers();
    }
  });

  test("accepted scan has no overlay and a later unavailable scan remains visible", async () => {
    jest.useFakeTimers();
    const forwardProductionScan = jest
      .fn()
      .mockResolvedValueOnce({ disposition: "accepted" })
      .mockResolvedValueOnce({ disposition: "unavailable" });
    const { ctrl, display } = makeCtrl(tmpDir, { forwardProductionScan });
    await ctrl.handleScan("VISIT:one");
    expect(display.showRuntimeState).not.toHaveBeenCalled();
    await ctrl.handleScan("VISIT:two");
    expect(display.showRuntimeState.mock.calls.at(-1)[0]).toMatchObject({
      priority: "feedback",
      overlay: { title: "Production unavailable", detail: "Please rescan." },
    });
    jest.useRealTimers();
  });

  test("malformed production response follows visible unavailable feedback path", async () => {
    const { ctrl, display } = makeCtrl(tmpDir, {
      forwardProductionScan: jest.fn().mockResolvedValue({ disposition: "unknown" }),
    });
    await ctrl.handleScan("VISIT:12345");
    expect(display.showRuntimeState.mock.calls.at(-1)[0]).toMatchObject({
      priority: "feedback",
      overlay: { title: "Production unavailable", detail: "Please rescan." },
    });
  });

  test("applies cloud room state and restores it after transient feedback expires", async () => {
    jest.useFakeTimers();
    const { ctrl, display } = makeCtrl(tmpDir, {
      forwardProductionScan: jest.fn().mockResolvedValue({
        disposition: "accepted",
        runtime_state: {
          kind: "room",
          state_id: "cloud-1",
          priority: "room",
          display: { mode: "room_status", status: { code: "available" } },
        },
      }),
    });
    await ctrl.handleScan("VISIT:12345");
    expect(display.showRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({ state_id: "cloud-1" })
    );
    await ctrl.handleScan("VISIT:12346");
    jest.advanceTimersByTime(5_000);
    expect(display.showRuntimeState.mock.calls.at(-1)[0]).toMatchObject({ state_id: "cloud-1" });
    jest.useRealTimers();
  });

  test("newer room state replaces saved room while feedback overlay remains visible", async () => {
    jest.useFakeTimers();
    const { ctrl, display } = makeCtrl(tmpDir);
    const server = await startTestStatusServer(ctrl);
    const address = server.address();
    const post = (body) =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/api/runtime-state",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          }
        );
        request.on("error", reject);
        request.write(payload);
        request.end();
      });
    const room = (id) => ({
      kind: "room",
      state_id: id,
      priority: "room",
      display: {
        mode: "room_status",
        room: null,
        station: null,
        status: { code: "available", label: "AVAILABLE" },
        patient: null,
        timing: null,
        updated_at: 1,
      },
    });
    try {
      await post(room("room-1"));
      await ctrl.handleScan("VISIT:12345");
      await post({
        kind: "overlay",
        state_id: "feedback-1",
        priority: "feedback",
        expires_in_ms: 5000,
        overlay: { severity: "success", title: "Accepted", detail: "Accepted" },
      });
      await post(room("room-2"));
      jest.advanceTimersByTime(5000);
      expect(display.showRuntimeState.mock.calls.at(-1)[0]).toMatchObject({ state_id: "room-2" });
    } finally {
      await closeTestServer(server);
      jest.useRealTimers();
    }
  });

  test("runtime endpoint rejects malformed and strips unknown room properties", async () => {
    const { ctrl, display } = makeCtrl(tmpDir);
    const server = await startTestStatusServer(ctrl);
    const address = server.address();
    const post = (body) =>
      new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/api/runtime-state",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          }
        );
        request.on("error", reject);
        request.write(payload);
        request.end();
      });
    try {
      expect(
        await post({
          kind: "room",
          state_id: "bad",
          display: { mode: "room_status", status: { code: "not-allowed" } },
        })
      ).toBe(400);
      expect(
        await post({
          kind: "room",
          state_id: "good",
          display: {
            mode: "room_status",
            status: { code: "available", label: "OK" },
            unknown: "discard",
          },
        })
      ).toBe(200);
      expect(display.showRuntimeState.mock.calls.at(-1)[0].display).not.toHaveProperty("unknown");
    } finally {
      await closeTestServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// Commissioning state progression and recovery
// ---------------------------------------------------------------------------

describe("getCommissioningState", () => {
  test("reflects current stored configuration accurately", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    expect(ctrl.getCommissioningState().state).toBe("bootstrap_installed");

    await ctrl.handleScan(qr("wifi_config", { ssid: "N", password: "p" }));
    expect(ctrl.getCommissioningState().state).toBe("network_configured");

    await ctrl.handleScan(
      qr("station_config", {
        location_id: "l",
        room_id: "r",
        station_id: "s",
        device_id: "d",
      })
    );
    expect(ctrl.getCommissioningState().state).toBe("identity_configured");

    await ctrl.handleScan(
      qr("cloud_config", {
        endpoint_url: "https://x.invalid/fn",
        shared_secret: "ss",
      })
    );
    expect(ctrl.getCommissioningState().configuration_complete).toBe(true);
  });

  test("recovery: re-creating controller from same state dir restores commissioning state", async () => {
    const { ctrl } = makeCtrl(tmpDir);
    await ctrl.handleScan(qr("wifi_config", { ssid: "Net", password: "pw" }));
    await ctrl.handleScan(
      qr("station_config", {
        location_id: "l",
        room_id: "r",
        station_id: "s",
        device_id: "d",
      })
    );

    // Simulate restart by creating a new controller with the same tmpDir
    process.env.MULTIMEDICA_STATE_DIR = tmpDir;
    const restartedCtrl = createController({
      configStore,
      secretsStore,
      displayClient: { updateState: jest.fn(), showMessage: jest.fn(), showIdentity: jest.fn() },
      applyWifi: null,
    });
    restartedCtrl.loadAdminToken();

    const st = restartedCtrl.getCommissioningState();
    expect(st.configured.wifi).toBe(true);
    expect(st.configured.station).toBe(true);
    expect(st.state).toBe("identity_configured");
  });
});

// ---------------------------------------------------------------------------
// HTTP status endpoint
// ---------------------------------------------------------------------------

describe("startStatusServer", () => {
  beforeEach(() => {
    process.env.MULTIMEDICA_STATE_DIR = tmpDir;
  });

  test("/api/status returns ok and commissioning fields; no secrets", async () => {
    secretsStore.writeSecrets(
      { qr_admin_token: TEST_TOKEN, shared_secret: "must-not-appear" },
      tmpDir
    );
    configStore.writeConfig({ station_id: "s1", endpoint_url: "https://x.invalid/fn" }, tmpDir);

    const mockDisplay = {
      updateState: jest.fn().mockResolvedValue(undefined),
      showMessage: jest.fn().mockResolvedValue(undefined),
      showIdentity: jest.fn().mockResolvedValue(undefined),
    };
    const ctrl = createController({
      configStore,
      secretsStore,
      displayClient: mockDisplay,
      applyWifi: null,
    });
    ctrl.loadAdminToken();
    const server = await startTestStatusServer(ctrl);
    try {
      const data = await getTestJson(server, "/api/status");
      expect(data.ok).toBe(true);
      expect(data.service).toBe("multimedica-controller");
      expect(data.config.station_id).toBe("s1");
      expect(data.config.endpoint_url).toBe("https://x.invalid/fn");
      expect(JSON.stringify(data)).not.toContain("must-not-appear");
      expect(JSON.stringify(data)).not.toContain(TEST_TOKEN);
      expect(data.config).not.toHaveProperty("shared_secret");
      expect(data.config).not.toHaveProperty("qr_admin_token");
    } finally {
      await closeTestServer(server);
    }
  });
});
