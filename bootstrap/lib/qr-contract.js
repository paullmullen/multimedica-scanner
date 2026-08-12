"use strict";

/**
 * QR Contract — Multimedica Scanner Bootstrap Layer
 *
 * Parses and validates provisioning QR codes.
 *
 * Differences from the root configQr.js this will eventually replace:
 *   - Admin token is supplied by the caller (from secrets-store) rather than
 *     read from process.env.SCANNER_QR_ADMIN_TOKEN.
 *   - No file I/O. Persistence is the caller's responsibility.
 *   - wifi_config passes payload.security through to result.runtime.
 *   - Identifier fields in station_config are validated against a safe pattern.
 *   - endpoint_url in cloud_config must begin with https://.
 *
 * The root configQr.js remains in place for backward compatibility with
 * scanner.js until that consumer migrates (Milestone 4).
 */

const CONFIG_QR_PREFIX = "MMCFG:";
const SUPPORTED_VERSION = 1;
const WIFI_SECURITY_VALUES = ["wpa-psk", "none"];
const STATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Public: prefix detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the raw scan value is a configuration QR.
 * @param {string} scanValue
 * @returns {boolean}
 */
function isConfigQr(scanValue) {
  return typeof scanValue === "string" && scanValue.startsWith(CONFIG_QR_PREFIX);
}

// ---------------------------------------------------------------------------
// Internal: authorisation
// ---------------------------------------------------------------------------

function requireAdminAuth(data, adminToken) {
  const scanned = data?.auth?.admin_token ?? "";

  if (!adminToken) {
    return { ok: false, error: "Missing admin token" };
  }

  if (!data.auth || scanned !== adminToken) {
    return { ok: false, error: "Invalid admin token" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// wifi_config
// ---------------------------------------------------------------------------

function validateWifiPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing wifi payload" };
  }
  if (!payload.ssid) {
    return { ok: false, error: "Missing ssid" };
  }
  if (payload.password === undefined) {
    return { ok: false, error: "Missing password" };
  }
  if (payload.security !== undefined && !WIFI_SECURITY_VALUES.includes(payload.security)) {
    return { ok: false, error: `Invalid security value: ${payload.security}` };
  }
  return { ok: true };
}

function handleWifiConfig(data) {
  const p = data.payload ?? {};
  const valid = validateWifiPayload(p);
  if (!valid.ok) return valid;

  return {
    ok: true,
    kind: "wifi_config",
    applied: { SSID: p.ssid },
    // password must not be logged by callers; security is non-secret
    runtime: {
      ssid: p.ssid,
      password: p.password,
      security: p.security ?? "wpa-psk",
    },
  };
}

// ---------------------------------------------------------------------------
// station_config
// ---------------------------------------------------------------------------

function validateStationPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing station config payload" };
  }
  for (const field of ["location_id", "room_id", "station_id", "device_id"]) {
    if (!payload[field]) {
      return { ok: false, error: `Missing ${field}` };
    }
    if (!STATION_ID_PATTERN.test(String(payload[field]))) {
      return { ok: false, error: `Invalid ${field}: must match ${STATION_ID_PATTERN.source}` };
    }
  }
  return { ok: true };
}

function handleStationConfig(data) {
  const p = data.payload ?? {};
  const valid = validateStationPayload(p);
  if (!valid.ok) return valid;

  return {
    ok: true,
    kind: "station_config",
    applied: {
      LOCATION_ID: p.location_id,
      ROOM_ID: p.room_id,
      STATION_ID: p.station_id,
      DEVICE_ID: p.device_id,
    },
  };
}

// ---------------------------------------------------------------------------
// cloud_config
// ---------------------------------------------------------------------------

function validateCloudPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing cloud config payload" };
  }
  if (!payload.endpoint_url) {
    return { ok: false, error: "Missing endpoint_url" };
  }
  if (!/^https:\/\//.test(payload.endpoint_url)) {
    return { ok: false, error: "endpoint_url must begin with https://" };
  }
  if (!payload.shared_secret) {
    return { ok: false, error: "Missing shared_secret" };
  }
  return { ok: true };
}

function handleCloudConfig(data) {
  const p = data.payload ?? {};
  const valid = validateCloudPayload(p);
  if (!valid.ok) return valid;

  return {
    ok: true,
    kind: "cloud_config",
    applied: {
      ENDPOINT_URL: p.endpoint_url,
      SHARED_SECRET: "[REDACTED]",
    },
    // shared_secret must be stored in secrets-store only; never logged
    runtime: {
      ENDPOINT_URL: p.endpoint_url,
      SHARED_SECRET: p.shared_secret,
    },
  };
}

// ---------------------------------------------------------------------------
// Public: main QR handler
// ---------------------------------------------------------------------------

/**
 * Parse and validate a configuration QR scan value.
 *
 * The adminToken parameter must be obtained from secrets-store.getAdminToken()
 * at the call site. This function never reads process.env.
 *
 * @param {string} scanValue  Raw scan value starting with MMCFG:
 * @param {string} adminToken Expected admin token for auth check
 * @returns {{ ok: boolean, kind?: string, applied?: object, runtime?: object, error?: string }}
 */
function handleConfigQr(scanValue, adminToken) {
  try {
    const json = scanValue.slice(CONFIG_QR_PREFIX.length);
    const data = JSON.parse(json);

    if (!data.kind || !data.version) {
      return { ok: false, error: "Invalid config format" };
    }

    if (data.version !== SUPPORTED_VERSION) {
      return { ok: false, error: `Unsupported version: ${data.version}` };
    }

    const auth = requireAdminAuth(data, adminToken);
    if (!auth.ok) return auth;

    switch (data.kind) {
      case "show_identity":
        return { ok: true, kind: "show_identity", applied: {}, runtime: {} };
      case "cloud_config":
        return handleCloudConfig(data);
      case "station_config":
        return handleStationConfig(data);
      case "wifi_config":
        return handleWifiConfig(data);
      default:
        return { ok: false, error: `Unknown config kind: ${data.kind}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isConfigQr,
  handleConfigQr,
  CONFIG_QR_PREFIX,
  SUPPORTED_VERSION,
  WIFI_SECURITY_VALUES,
  STATION_ID_PATTERN,
};
