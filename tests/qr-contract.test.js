"use strict";

/**
 * QR Contract Tests
 *
 * Tests qr-contract.js and validates that:
 * 1. All fixture QR strings produce the expected result
 * 2. The admin token is never read from process.env (always from the caller)
 * 3. The security field is passed through from wifi_config payloads
 * 4. Invalid inputs are rejected with ok:false
 *
 * Contract fixtures use the test token "test-token" — the fleet token is
 * not used in or required by these tests.
 */

const fs = require("fs");
const path = require("path");

const {
  isConfigQr,
  handleConfigQr,
  CONFIG_QR_PREFIX,
  SUPPORTED_VERSION,
} = require("../bootstrap/lib/qr-contract");

const TEST_TOKEN = "test-token";
const FIXTURE_DIR = path.join(__dirname, "fixtures");

// ---------------------------------------------------------------------------
// Ensure process.env.SCANNER_QR_ADMIN_TOKEN is absent for the entire suite.
// qr-contract.js must never consult it.
// ---------------------------------------------------------------------------
beforeAll(() => {
  delete process.env.SCANNER_QR_ADMIN_TOKEN;
});

afterAll(() => {
  delete process.env.SCANNER_QR_ADMIN_TOKEN;
});

// ---------------------------------------------------------------------------
// isConfigQr
// ---------------------------------------------------------------------------
describe("isConfigQr", () => {
  test("returns true for MMCFG: prefix", () => {
    expect(isConfigQr('MMCFG:{"kind":"show_identity"}')).toBe(true);
  });

  test("returns false for VISIT: scan", () => {
    expect(isConfigQr("VISIT:12345")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isConfigQr("")).toBe(false);
  });

  test("returns false for lowercase mmcfg:", () => {
    expect(isConfigQr('mmcfg:{"kind":"show_identity"}')).toBe(false);
  });

  test("returns false for non-string", () => {
    expect(isConfigQr(null)).toBe(false);
    expect(isConfigQr(undefined)).toBe(false);
    expect(isConfigQr(42)).toBe(false);
  });

  test("CONFIG_QR_PREFIX constant is MMCFG:", () => {
    expect(CONFIG_QR_PREFIX).toBe("MMCFG:");
  });

  test("SUPPORTED_VERSION constant is 1", () => {
    expect(SUPPORTED_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven contract tests
// ---------------------------------------------------------------------------
describe("QR contract fixtures", () => {
  const fixtureFiles = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.startsWith("qr_") && f.endsWith(".json"))
    .sort();

  test("at least 9 fixture files are present", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(9);
  });

  test.each(fixtureFiles)("fixture %s", (filename) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, filename), "utf8"));

    expect(fixture).toHaveProperty("qrString");
    expect(fixture).toHaveProperty("expectedResult");

    const result = handleConfigQr(fixture.qrString, TEST_TOKEN);
    expect(result).toMatchObject(fixture.expectedResult);
  });
});

// ---------------------------------------------------------------------------
// Token isolation: env var must have no effect
// ---------------------------------------------------------------------------
describe("handleConfigQr token isolation", () => {
  test("env var set to test-token does not affect rejection of wrong token in QR", () => {
    process.env.SCANNER_QR_ADMIN_TOKEN = TEST_TOKEN;
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net", password: "pass" },
      auth: { admin_token: "wrong-token" },
    })}`;
    // Must still reject because the QR contains the wrong token
    const result = handleConfigQr(qr, TEST_TOKEN);
    expect(result.ok).toBe(false);
    delete process.env.SCANNER_QR_ADMIN_TOKEN;
  });

  test("works correctly with no env var present", () => {
    delete process.env.SCANNER_QR_ADMIN_TOKEN;
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net", password: "pass" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    const result = handleConfigQr(qr, TEST_TOKEN);
    expect(result.ok).toBe(true);
  });

  test("show_identity does not require auth", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "show_identity",
      version: 1,
      payload: {},
    })}`;
    expect(handleConfigQr(qr, null)).toMatchObject({
      ok: true,
      kind: "show_identity",
      applied: {},
      runtime: {},
    });
  });

  test("show_identity rejects configuration fields", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "show_identity",
      version: 1,
      payload: { endpoint_url: "https://example.invalid" },
    })}`;
    expect(handleConfigQr(qr, null).ok).toBe(false);
  });

  test("rejects when explicit adminToken is null (no token configured)", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net", password: "pass" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    const result = handleConfigQr(qr, null);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing admin token/i);
  });
});

// ---------------------------------------------------------------------------
// wifi_config — security field pass-through
// ---------------------------------------------------------------------------
describe("wifi_config security field", () => {
  test("passes security field through to runtime when present", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net", password: "pass", security: "wpa-psk" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    const result = handleConfigQr(qr, TEST_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.runtime.security).toBe("wpa-psk");
  });

  test("defaults security to wpa-psk when omitted", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net", password: "pass" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    const result = handleConfigQr(qr, TEST_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.runtime.security).toBe("wpa-psk");
  });

  test("accepts security:none for open networks", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "OpenNet", password: "", security: "none" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    const result = handleConfigQr(qr, TEST_TOKEN);
    expect(result.ok).toBe(true);
    expect(result.runtime.security).toBe("none");
  });

  test("rejects invalid security value", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net", password: "pass", security: "wep" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(false);
  });

  test("rejects missing ssid", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { password: "pass" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(false);
  });

  test("rejects missing password", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(false);
  });

  test("does not expose password in applied", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net", password: "secret-pass" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    const result = handleConfigQr(qr, TEST_TOKEN);
    expect(result.applied).not.toHaveProperty("password");
    expect(JSON.stringify(result.applied)).not.toContain("secret-pass");
  });
});

// ---------------------------------------------------------------------------
// station_config — identifier validation
// ---------------------------------------------------------------------------
describe("station_config identifier validation", () => {
  test("rejects location_id with space", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "station_config",
      version: 1,
      payload: { location_id: "loc 1", room_id: "r1", station_id: "s1", device_id: "d1" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(false);
  });

  test("accepts identifiers with hyphens and underscores", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "station_config",
      version: 1,
      payload: {
        location_id: "loc-1",
        room_id: "loc-1_room-1",
        station_id: "nursing",
        device_id: "scanner_loc-1_01",
      },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(true);
  });

  test("rejects missing device_id", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "station_config",
      version: 1,
      payload: { location_id: "loc1", room_id: "r1", station_id: "s1" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cloud_config — URL validation
// ---------------------------------------------------------------------------
describe("cloud_config URL validation", () => {
  test("rejects http:// endpoint_url", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "cloud_config",
      version: 1,
      payload: { endpoint_url: "http://example.com/endpoint", shared_secret: "sec" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(false);
  });

  test("accepts https:// endpoint_url", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "cloud_config",
      version: 1,
      payload: { endpoint_url: "https://example.invalid/fn", shared_secret: "sec" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(true);
  });

  test("redacts SHARED_SECRET in applied", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "cloud_config",
      version: 1,
      payload: { endpoint_url: "https://example.invalid/fn", shared_secret: "real-secret" },
      auth: { admin_token: TEST_TOKEN },
    })}`;
    const result = handleConfigQr(qr, TEST_TOKEN);
    expect(result.applied.SHARED_SECRET).toBe("[REDACTED]");
    expect(JSON.stringify(result.applied)).not.toContain("real-secret");
  });
});

// ---------------------------------------------------------------------------
// Version and envelope
// ---------------------------------------------------------------------------
describe("envelope validation", () => {
  test("rejects version 2", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "show_identity",
      version: 2,
      payload: {},
      auth: { admin_token: TEST_TOKEN },
    })}`;
    const result = handleConfigQr(qr, TEST_TOKEN);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("2");
  });

  test("rejects missing version", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "show_identity",
      payload: {},
      auth: { admin_token: TEST_TOKEN },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(false);
  });

  test("rejects completely missing auth", () => {
    const qr = `MMCFG:${JSON.stringify({
      kind: "wifi_config",
      version: 1,
      payload: { ssid: "Net", password: "pass" },
    })}`;
    expect(handleConfigQr(qr, TEST_TOKEN).ok).toBe(false);
  });
});
