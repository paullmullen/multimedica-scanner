const fs = require("fs");
const { spawnSync } = require("child_process");

const ADMIN_TOKEN = process.env.SCANNER_QR_ADMIN_TOKEN;
const ENV_FILE_PATH = "/home/multimedica_edge/scanner/.env";

function isConfigQr(scanValue) {
  return scanValue.startsWith("MMCFG:");
}

function readEnvFileLines() {
  if (!fs.existsSync(ENV_FILE_PATH)) {
    throw new Error(`Environment file not found: ${ENV_FILE_PATH}`);
  }
  return fs.readFileSync(ENV_FILE_PATH, "utf8").split(/\r?\n/);
}

function quoteIfNeeded(value) {
  const stringValue = String(value);
  if (/[ \t]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '\\"')}"`;
  }
  return stringValue;
}

function updateEnvFile(updates) {
  const lines = readEnvFileLines();
  const keysToUpdate = Object.keys(updates);
  const seenKeys = new Set();

  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return line;

    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;

    seenKeys.add(key);
    return `${key}=${quoteIfNeeded(updates[key])}`;
  });

  for (const key of keysToUpdate) {
    if (!seenKeys.has(key)) {
      nextLines.push(`${key}=${quoteIfNeeded(updates[key])}`);
    }
  }

  const output = nextLines.join("\n").replace(/\n+$/, "") + "\n";
  fs.writeFileSync(ENV_FILE_PATH, output, "utf8");
}

function requireAdminAuth(data) {
  const scannedToken = data?.auth?.admin_token || "";

  if (!ADMIN_TOKEN) {
    return { ok: false, error: "Missing SCANNER_QR_ADMIN_TOKEN in environment" };
  }

  if (!data.auth || scannedToken !== ADMIN_TOKEN) {
    return { ok: false, error: "Invalid admin token" };
  }

  return { ok: true };
}

// ------------------
// CLOUD CONFIG
// ------------------

function validateCloudConfigPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing cloud config payload" };
  }

  if (!payload.endpoint_url) {
    return { ok: false, error: "Missing endpoint_url" };
  }

  if (!payload.shared_secret) {
    return { ok: false, error: "Missing shared_secret" };
  }

  return { ok: true };
}

function handleCloudConfig(data) {
  const p = data.payload || {};
  const valid = validateCloudConfigPayload(p);
  if (!valid.ok) return valid;

  updateEnvFile({
    ENDPOINT_URL: p.endpoint_url,
    SHARED_SECRET: p.shared_secret,
  });

  return {
    ok: true,
    kind: "cloud_config",
    applied: {
      ENDPOINT_URL: p.endpoint_url,
      SHARED_SECRET: "[REDACTED]",
    },
    runtime: {
      ENDPOINT_URL: p.endpoint_url,
      SHARED_SECRET: p.shared_secret,
    },
  };
}

// ------------------
// STATION CONFIG
// ------------------

function validateStationConfigPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing station config payload" };
  }

  if (!payload.room_id) return { ok: false, error: "Missing room_id" };
  if (!payload.station_id) return { ok: false, error: "Missing station_id" };
  if (!payload.device_id) return { ok: false, error: "Missing device_id" };

  return { ok: true };
}

function handleStationConfig(data) {
  const p = data.payload || {};
  const valid = validateStationConfigPayload(p);
  if (!valid.ok) return valid;

  updateEnvFile({
    ROOM_ID: p.room_id,
    STATION_ID: p.station_id,
    DEVICE_ID: p.device_id,
  });

  return {
    ok: true,
    kind: "station_config",
    applied: {
      ROOM_ID: p.room_id,
      STATION_ID: p.station_id,
      DEVICE_ID: p.device_id,
    },
  };
}

// ------------------
// WIFI CONFIG (NEW)
// ------------------

function validateWifiConfigPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing wifi payload" };
  }

  if (!payload.ssid) return { ok: false, error: "Missing ssid" };
  if (payload.password === undefined)
    return { ok: false, error: "Missing password" };

  return { ok: true };
}

function applyWifiConfig(ssid, password) {
  try {
    // Delete old connection if exists
    spawnSync("nmcli", ["connection", "delete", ssid]);

    // Add new connection
    spawnSync("nmcli", [
      "device",
      "wifi",
      "connect",
      ssid,
      "password",
      password,
    ]);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function handleWifiConfig(data) {
  const p = data.payload || {};
  const valid = validateWifiConfigPayload(p);
  if (!valid.ok) return valid;

  const result = applyWifiConfig(p.ssid, p.password);

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return {
    ok: true,
    kind: "wifi_config",
    applied: {
      SSID: p.ssid,
    },
  };
}

// ------------------
// MAIN HANDLER
// ------------------

function handleConfigQr(scanValue) {
  try {
    const json = scanValue.replace(/^MMCFG:/, "");
    const data = JSON.parse(json);

    if (!data.kind || !data.version) {
      return { ok: false, error: "Invalid config format" };
    }

    if (data.version !== 1) {
      return { ok: false, error: `Unsupported version: ${data.version}` };
    }

    const authResult = requireAdminAuth(data);
    if (!authResult.ok) return authResult;

    if (data.kind === "cloud_config") return handleCloudConfig(data);
    if (data.kind === "station_config") return handleStationConfig(data);
    if (data.kind === "wifi_config") return handleWifiConfig(data);

    return { ok: false, error: `Unknown config kind: ${data.kind}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isConfigQr,
  handleConfigQr,
};