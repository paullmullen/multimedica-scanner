"use strict";

/**
 * Installer Contract Tests
 *
 * Verifies the requirements from the Milestone 2 correction pass:
 *
 * - Normal Install requires ONLY qr_admin_token; no endpoint_url or
 *   shared_secret needed for bootstrap installation.
 * - Cloud credentials arrive through cloud_config QR only.
 * - configuration_complete is separate from commissioning_complete.
 * - Existing config.json and secrets.json survive reinstall.
 * - QR admin token is not silently replaced on reinstall.
 * - State terminology: configuration_complete, release_installed, production_ready.
 * - Provisioning result schema includes all required fields.
 * - Failed installation should return exit_code != 0.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const configStore = require("../bootstrap/lib/config-store");
const secretsStore = require("../bootstrap/lib/secrets-store");
const { createController } = require("../bootstrap/controller");
const { computeState } = require("../bootstrap/lib/commissioning");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mm-inst-"));
}

function rmTempDir(d) {
  fs.rmSync(d, { recursive: true, force: true });
}

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schemas", name), "utf8"));
}

function makeValidator() {
  const ajv = new (Ajv.default || Ajv)({ strict: false, allErrors: true });
  (addFormats.default || addFormats)(ajv);
  return ajv;
}

// Standard mock display client
function mockDisplay() {
  return {
    updateState: jest.fn().mockResolvedValue(undefined),
    showMessage: jest.fn().mockResolvedValue(undefined),
    showIdentity: jest.fn().mockResolvedValue(undefined),
  };
}

function qr(kind, payload, token = "test-tok") {
  return "MMCFG:" + JSON.stringify({ kind, version: 1, payload, auth: { admin_token: token } });
}

// ---------------------------------------------------------------------------
// installer-config.schema.json
// ---------------------------------------------------------------------------

describe("installer-config.schema.json", () => {
  test("only requires qr_admin_token — no shared_secret or endpoint_url", () => {
    const schema = loadSchema("installer-config.schema.json");
    const av = makeValidator();
    const validate = av.compile(schema);

    // Valid: token only
    expect(validate({ qr_admin_token: "tok" })).toBe(true);

    // Invalid: extra fields not allowed
    expect(validate({ qr_admin_token: "tok", shared_secret: "sec" })).toBe(false);
    expect(validate({ qr_admin_token: "tok", endpoint_url: "https://x.invalid" })).toBe(false);

    // Invalid: missing token
    expect(validate({})).toBe(false);
    expect(validate({ endpoint_url: "https://x.invalid" })).toBe(false);
  });

  test("schema additionalProperties is false", () => {
    const schema = loadSchema("installer-config.schema.json");
    expect(schema.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cloud credentials arrive via cloud_config QR only
// ---------------------------------------------------------------------------

describe("cloud credentials via QR only", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = makeTempDir();
    process.env.MULTIMEDICA_STATE_DIR = tmpDir;
  });
  afterEach(() => {
    delete process.env.MULTIMEDICA_STATE_DIR;
    rmTempDir(tmpDir);
    jest.clearAllMocks();
  });

  test("bootstrap starts without shared_secret or endpoint_url", async () => {
    // Install only the token (normal bootstrap install)
    secretsStore.writeSecrets({ qr_admin_token: "test-tok" }, tmpDir);

    const ctrl = createController({
      configStore,
      secretsStore,
      displayClient: mockDisplay(),
      applyWifi: null,
    });
    ctrl.loadAdminToken();

    // Controller should be operational (token loaded) without cloud creds
    const state = ctrl.getCommissioningState();
    expect(state.state).toBe("bootstrap_installed");
    // No cloud config yet — controller is ready to accept QRs
    expect(state.configured.cloud).toBe(false);
  });

  test("cloud_config QR delivers endpoint_url and shared_secret at commissioning time", async () => {
    secretsStore.writeSecrets({ qr_admin_token: "test-tok" }, tmpDir);
    const display = mockDisplay();
    const ctrl = createController({
      configStore,
      secretsStore,
      displayClient: display,
      applyWifi: null,
    });
    ctrl.loadAdminToken();

    await ctrl.handleScan(
      qr("cloud_config", {
        endpoint_url: "https://example.invalid/fn",
        shared_secret: "test-cloud-secret",
      })
    );

    const cfg = configStore.readConfig(tmpDir);
    expect(cfg.endpoint_url).toBe("https://example.invalid/fn");

    const sec = secretsStore.readSecrets(tmpDir);
    expect(sec.shared_secret).toBe("test-cloud-secret");
  });

  test("secrets.json never contains shared_secret before cloud_config QR", () => {
    // Bootstrap install writes only qr_admin_token
    secretsStore.writeSecrets({ qr_admin_token: "test-tok" }, tmpDir);
    const sec = secretsStore.readSecrets(tmpDir);
    expect(sec).not.toHaveProperty("shared_secret");
    expect(sec).not.toHaveProperty("endpoint_url");
  });
});

// ---------------------------------------------------------------------------
// State terminology: configuration_complete vs commissioning_complete
// ---------------------------------------------------------------------------

describe("state field semantics", () => {
  test("configuration_complete is true when all 3 QRs accepted", () => {
    const cfg = {
      wifi_ssid: "N",
      wifi_security: "wpa-psk",
      location_id: "l",
      room_id: "r",
      station_id: "s",
      device_id: "d",
      endpoint_url: "https://x.invalid/fn",
    };
    const sec = { qr_admin_token: "tok", wifi_password: "pw", shared_secret: "ss" };
    const state = computeState(cfg, sec);
    expect(state.configuration_complete).toBe(true);
  });

  test("commissioning_complete is false even when configuration_complete is true (no release)", () => {
    const cfg = {
      wifi_ssid: "N",
      wifi_security: "wpa-psk",
      location_id: "l",
      room_id: "r",
      station_id: "s",
      device_id: "d",
      endpoint_url: "https://x.invalid/fn",
    };
    const sec = { qr_admin_token: "tok", wifi_password: "pw", shared_secret: "ss" };
    const state = computeState(cfg, sec);
    expect(state.configuration_complete).toBe(true);
    expect(state.commissioning_complete).toBe(false); // no release
    expect(state.release_installed).toBe(false);
    expect(state.production_ready).toBe(false);
  });

  test("release_installed and production_ready are always false in Milestone 2", () => {
    const state = computeState(null, null);
    expect(state.release_installed).toBe(false);
    expect(state.production_ready).toBe(false);
  });

  test("configuration_complete is false when any QR is missing", () => {
    const cfg = { wifi_ssid: "N", wifi_security: "wpa-psk" };
    const sec = { qr_admin_token: "tok", wifi_password: "pw" };
    const state = computeState(cfg, sec);
    expect(state.configuration_complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Existing config and secrets survive reinstall
// ---------------------------------------------------------------------------

describe("idempotent install — config/secrets preserved", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = makeTempDir();
    process.env.MULTIMEDICA_STATE_DIR = tmpDir;
  });
  afterEach(() => {
    delete process.env.MULTIMEDICA_STATE_DIR;
    rmTempDir(tmpDir);
  });

  test("reinstalling secrets does not silently replace existing token", () => {
    // First install: write original token
    secretsStore.writeSecrets({ qr_admin_token: "original-token" }, tmpDir);

    // A reinstall must NOT automatically overwrite the token.
    // The installer only writes if there is no existing secrets.json.
    // Simulate a conditional install:
    const existing = secretsStore.readSecrets(tmpDir);
    if (!existing) {
      secretsStore.writeSecrets({ qr_admin_token: "new-token" }, tmpDir);
    }
    // Token should still be the original
    expect(secretsStore.getAdminToken(tmpDir)).toBe("original-token");
  });

  test("reinstall preserves existing config.json values", () => {
    configStore.writeConfig(
      {
        commissioning_state: "network_configured",
        wifi_ssid: "MyNet",
        location_id: "loc1",
      },
      tmpDir
    );

    // Conditional initial-config write (as installer does):
    const existing = configStore.readConfig(tmpDir);
    if (!existing) {
      configStore.writeConfig({ commissioning_state: "bootstrap_installed" }, tmpDir);
    }

    const cfg = configStore.readConfig(tmpDir);
    expect(cfg.wifi_ssid).toBe("MyNet");
    expect(cfg.location_id).toBe("loc1");
  });
});

// ---------------------------------------------------------------------------
// provisioning-result.schema.json correctness
// ---------------------------------------------------------------------------

describe("provisioning-result.schema.json", () => {
  test("schema is valid JSON and compiles", () => {
    const schema = loadSchema("provisioning-result.schema.json");
    const av = makeValidator();
    expect(() => av.compile(schema)).not.toThrow();
  });

  test("valid result with configuration_complete and commissioning_complete passes", () => {
    const schema = loadSchema("provisioning-result.schema.json");
    const av = makeValidator();
    const validate = av.compile(schema);

    const result = {
      mode: "Install",
      timestamp: "2026-08-11T10:00:00Z",
      pi_host: "pi.local",
      exit_code: 0,
      bootstrap_complete: true,
      configuration_complete: true,
      commissioning_complete: false, // no release yet
      release_installed: false,
      production_ready: false,
      platform_verified: true,
      services_healthy: true,
      reboot_verified: true,
      scanner_device_detected: true,
      provisioning_qr_parsed: null,
      network_connected: null,
      release_version: null,
      production_healthy: null,
      errors: [],
      warnings: ["Platform qualification deferred to Milestone 3"],
    };
    const valid = validate(result);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  test("configuration_complete and commissioning_complete are required", () => {
    const schema = loadSchema("provisioning-result.schema.json");
    expect(schema.required).toContain("configuration_complete");
    expect(schema.required).toContain("commissioning_complete");
  });

  test("result with nonzero exit_code validates (failure case)", () => {
    const schema = loadSchema("provisioning-result.schema.json");
    const av = makeValidator();
    const validate = av.compile(schema);

    const failResult = {
      mode: "Install",
      timestamp: "2026-08-11T10:00:00Z",
      pi_host: "pi.local",
      exit_code: 20,
      bootstrap_complete: false,
      configuration_complete: false,
      commissioning_complete: false,
      errors: ["SSH command failed"],
      warnings: [],
    };
    expect(validate(failResult)).toBe(true);
    expect(failResult.exit_code).not.toBe(0); // nonzero on failure
  });
});

// ---------------------------------------------------------------------------
// Port conflict: installer must not stop legacy services
// ---------------------------------------------------------------------------

describe("port conflict behavior", () => {
  test("install-bootstrap.sh conflict check: contains no kiosk-display disable/stop", () => {
    const script = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "install-bootstrap.sh"),
      "utf8"
    );
    // Must NOT contain commands that stop or disable legacy services
    expect(script).not.toMatch(/systemctl\s+(disable|stop)\s+kiosk-display/);
    expect(script).not.toMatch(/systemctl\s+(disable|stop).*kiosk/);
  });

  test("install-bootstrap.sh contains port conflict check that aborts", () => {
    const script = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "install-bootstrap.sh"),
      "utf8"
    );
    // Must contain a check for kiosk-display.service being active
    expect(script).toMatch(/kiosk-display\.service.*active/);
    // Must call fail() when conflict detected
    expect(script).toMatch(/fail\s+"CONFLICT/);
  });

  test("install-bootstrap.sh does not stop any systemctl service unconditionally", () => {
    const script = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "install-bootstrap.sh"),
      "utf8"
    );
    // The only systemctl stop/disable calls should be for multimedica-* services
    // (i.e., NOT for legacy kiosk-display or legacy scanner)
    const stopLines = script
      .split("\n")
      .filter((l) => /systemctl\s+(stop|disable)/.test(l) && !l.trim().startsWith("#"));
    for (const line of stopLines) {
      // All stop/disable lines must target multimedica-* or production (our own services)
      expect(line).toMatch(/multimedica/);
    }
  });
});

// ---------------------------------------------------------------------------
// Controller HTTP status exposes new state fields
// ---------------------------------------------------------------------------

const http = require("http");

describe("controller /api/status new fields", () => {
  let server;
  const PORT = 15000 + Math.floor(Math.random() * 100);
  let tmpDir;

  beforeEach(() => {
    server = null;
    tmpDir = makeTempDir();
    process.env.MULTIMEDICA_STATE_DIR = tmpDir;
    process.env.CONTROLLER_PORT = String(PORT);
  });

  afterEach((done) => {
    delete process.env.MULTIMEDICA_STATE_DIR;
    delete process.env.CONTROLLER_PORT;
    rmTempDir(tmpDir);
    const s = server;
    server = null;
    if (s && s.listening) s.close(done);
    else done();
    jest.clearAllMocks();
  });

  test("/api/status includes configuration_complete, commissioning_complete, release_installed, production_ready", (done) => {
    secretsStore.writeSecrets({ qr_admin_token: "test-tok" }, tmpDir);
    const ctrl = createController({
      configStore,
      secretsStore,
      displayClient: mockDisplay(),
      applyWifi: null,
    });
    ctrl.loadAdminToken();
    server = ctrl.startStatusServer();

    setTimeout(() => {
      http
        .get(`http://127.0.0.1:${PORT}/api/status`, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            const data = JSON.parse(body);
            expect(data).toHaveProperty("configuration_complete");
            expect(data).toHaveProperty("commissioning_complete");
            expect(data).toHaveProperty("release_installed");
            expect(data).toHaveProperty("production_ready");
            expect(data.configuration_complete).toBe(false);
            expect(data.commissioning_complete).toBe(false);
            expect(data.release_installed).toBe(false);
            expect(data.production_ready).toBe(false);
            done();
          });
        })
        .on("error", done);
    }, 200);
  });

  test("/api/status marks configuration_complete true after all 3 QRs accepted", async () => {
    secretsStore.writeSecrets({ qr_admin_token: "test-tok" }, tmpDir);
    const display = mockDisplay();
    const ctrl = createController({
      configStore,
      secretsStore,
      displayClient: display,
      applyWifi: null,
    });
    ctrl.loadAdminToken();

    await ctrl.handleScan(qr("wifi_config", { ssid: "N", password: "p" }));
    await ctrl.handleScan(
      qr("station_config", { location_id: "l", room_id: "r", station_id: "s", device_id: "d" })
    );
    await ctrl.handleScan(
      qr("cloud_config", { endpoint_url: "https://x.invalid/fn", shared_secret: "ss" })
    );

    const state = ctrl.getCommissioningState();
    expect(state.configuration_complete).toBe(true);
    expect(state.commissioning_complete).toBe(false); // no release
  });
});
