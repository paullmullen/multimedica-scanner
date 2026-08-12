"use strict";

/**
 * Commissioning State Tests
 *
 * Tests for bootstrap/lib/commissioning.js â€” pure functions, no I/O.
 * All credentials are fake test values.
 */

const {
  computeState,
  getStateMessage,
  REQUIRED_CONFIG,
  REQUIRED_SECRETS,
} = require("../bootstrap/lib/commissioning");

// ---------------------------------------------------------------------------
// computeState
// ---------------------------------------------------------------------------

describe("computeState", () => {
  test("null config and null secrets â†’ bootstrap_installed, not complete, all missing", () => {
    const s = computeState(null, null);
    expect(s.state).toBe("bootstrap_installed");
    expect(s.configuration_complete).toBe(false);
    expect(s.missing).toContain("wifi_config");
    expect(s.missing).toContain("station_config");
    expect(s.missing).toContain("cloud_config");
    expect(s.configured.wifi).toBe(false);
    expect(s.configured.station).toBe(false);
    expect(s.configured.cloud).toBe(false);
  });

  test("empty config and empty secrets â†’ bootstrap_installed", () => {
    const s = computeState({}, {});
    expect(s.state).toBe("bootstrap_installed");
    expect(s.configuration_complete).toBe(false);
  });

  test("Wi-Fi configured in config + secrets â†’ network_configured", () => {
    const cfg = { wifi_ssid: "TestNet", wifi_security: "wpa-psk" };
    const sec = { qr_admin_token: "fake-tok", wifi_password: "p" };
    const s = computeState(cfg, sec);
    expect(s.state).toBe("network_configured");
    expect(s.configured.wifi).toBe(true);
    expect(s.configured.station).toBe(false);
    expect(s.configured.cloud).toBe(false);
    expect(s.missing).not.toContain("wifi_config");
    expect(s.missing).toContain("station_config");
    expect(s.missing).toContain("cloud_config");
  });

  test("Wi-Fi ssid present but password absent â†’ not Wi-Fi configured", () => {
    const cfg = { wifi_ssid: "TestNet", wifi_security: "wpa-psk" };
    const sec = { qr_admin_token: "fake-tok" }; // no wifi_password
    const s = computeState(cfg, sec);
    expect(s.configured.wifi).toBe(false);
    expect(s.state).toBe("bootstrap_installed");
  });

  test("station config fully present â†’ identity_configured", () => {
    const cfg = {
      wifi_ssid: "N",
      wifi_security: "wpa-psk",
      location_id: "loc1",
      room_id: "r1",
      station_id: "s1",
      device_id: "d1",
    };
    const sec = { qr_admin_token: "fake-tok", wifi_password: "p" };
    const s = computeState(cfg, sec);
    expect(s.state).toBe("identity_configured");
    expect(s.configured.station).toBe(true);
    expect(s.missing).not.toContain("station_config");
    expect(s.missing).toContain("cloud_config");
  });

  test("partial station config (missing device_id) â†’ station not configured", () => {
    const cfg = {
      wifi_ssid: "N",
      wifi_security: "wpa-psk",
      location_id: "loc1",
      room_id: "r1",
      station_id: "s1",
      // device_id missing
    };
    const sec = { qr_admin_token: "fake-tok", wifi_password: "p" };
    const s = computeState(cfg, sec);
    expect(s.configured.station).toBe(false);
    expect(s.missing).toContain("station_config");
  });

  test("all three configured â†’ cloud_configured, complete", () => {
    const cfg = {
      wifi_ssid: "N",
      wifi_security: "wpa-psk",
      location_id: "loc1",
      room_id: "r1",
      station_id: "s1",
      device_id: "d1",
      endpoint_url: "https://example.invalid/fn",
    };
    const sec = {
      qr_admin_token: "fake-tok",
      wifi_password: "p",
      shared_secret: "ss",
    };
    const s = computeState(cfg, sec);
    expect(s.state).toBe("cloud_configured");
    expect(s.configuration_complete).toBe(true);
    expect(s.missing).toHaveLength(0);
    expect(s.configured.wifi).toBe(true);
    expect(s.configured.station).toBe(true);
    expect(s.configured.cloud).toBe(true);
  });

  test("cloud without wifi and station â†’ cloud_configured, NOT complete", () => {
    const cfg = { endpoint_url: "https://example.invalid/fn" };
    const sec = { qr_admin_token: "tok", shared_secret: "ss" };
    const s = computeState(cfg, sec);
    expect(s.state).toBe("cloud_configured");
    expect(s.configuration_complete).toBe(false);
    expect(s.missing).toContain("wifi_config");
    expect(s.missing).toContain("station_config");
  });

  test("state is deterministic: same inputs always return same result", () => {
    const cfg = { wifi_ssid: "N", wifi_security: "wpa-psk", endpoint_url: "https://x.invalid/fn" };
    const sec = { qr_admin_token: "tok", wifi_password: "p", shared_secret: "ss" };
    const s1 = computeState(cfg, sec);
    const s2 = computeState(cfg, sec);
    expect(s1).toEqual(s2);
  });

  test("computeState ignores stored commissioning_state field entirely", () => {
    // If config has commissioning_state='operational' but missing fields, state must reflect reality
    const cfg = { commissioning_state: "operational", wifi_ssid: "N", wifi_security: "wpa-psk" };
    const sec = { qr_admin_token: "tok", wifi_password: "p" };
    const s = computeState(cfg, sec);
    // Should NOT be 'operational'; should reflect actual missing fields
    expect(s.state).toBe("network_configured");
    expect(s.configuration_complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getStateMessage
// ---------------------------------------------------------------------------

describe("getStateMessage", () => {
  test("returns a non-empty string for every known state", () => {
    const states = [
      "starting",
      "bootstrap_installed",
      "network_configured",
      "identity_configured",
      "cloud_configured",
      "operational",
      "unknown_state",
    ];
    for (const state of states) {
      const msg = getStateMessage(state, []);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test("message never contains banned words that could indicate secrets", () => {
    // These words should never appear in operator-facing messages
    const banned = ["token", "password", "secret", "admin_token", "shared_secret"];
    const states = [
      "bootstrap_installed",
      "network_configured",
      "identity_configured",
      "cloud_configured",
    ];
    for (const state of states) {
      const msg = getStateMessage(state, ["wifi_config", "station_config"]).toLowerCase();
      for (const word of banned) {
        expect(msg).not.toContain(word);
      }
    }
  });

  test("missing fields are described without their actual values", () => {
    const msg = getStateMessage("network_configured", ["station_config", "cloud_config"]);
    expect(msg).not.toMatch(/[A-Za-z0-9]{10,}/); // no long secret-like strings
    expect(msg.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Required field constants
// ---------------------------------------------------------------------------

describe("REQUIRED_CONFIG and REQUIRED_SECRETS", () => {
  test("REQUIRED_CONFIG contains expected categories", () => {
    expect(REQUIRED_CONFIG).toHaveProperty("wifi");
    expect(REQUIRED_CONFIG).toHaveProperty("station");
    expect(REQUIRED_CONFIG).toHaveProperty("cloud");
  });

  test("REQUIRED_SECRETS contains expected categories", () => {
    expect(REQUIRED_SECRETS).toHaveProperty("wifi");
    expect(REQUIRED_SECRETS).toHaveProperty("cloud");
  });

  test("wifi config fields include ssid", () => {
    expect(REQUIRED_CONFIG.wifi).toContain("wifi_ssid");
  });

  test("station fields include all four identity fields", () => {
    expect(REQUIRED_CONFIG.station).toContain("location_id");
    expect(REQUIRED_CONFIG.station).toContain("room_id");
    expect(REQUIRED_CONFIG.station).toContain("station_id");
    expect(REQUIRED_CONFIG.station).toContain("device_id");
  });
});
