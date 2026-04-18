const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ENV_PATH = path.join(__dirname, ".env");
const WIFI_CONNECTION_NAME = "multimedica-scanner-wifi";
const WIFI_INTERFACE = "wlan0";

function isConfigQr(rawValue) {
  return typeof rawValue === "string" && rawValue.startsWith("MMCFG:");
}

function parseConfigQr(rawValue) {
  if (!isConfigQr(rawValue)) {
    return { ok: false, error: "Not a config QR" };
  }

  try {
    const jsonText = rawValue.slice("MMCFG:".length);
    const payload = JSON.parse(jsonText);
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: `Invalid config QR JSON: ${err.message}` };
  }
}

function validateStationConfig(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing payload object" };
  }

  if (payload.kind !== "station_config") {
    return { ok: false, error: `Unsupported config kind: ${payload.kind}` };
  }

  if (payload.version !== 1) {
    return { ok: false, error: `Unsupported config version: ${payload.version}` };
  }

  if (!payload.station_id || typeof payload.station_id !== "string") {
    return { ok: false, error: "station_id is required" };
  }

  if (!payload.room_id || typeof payload.room_id !== "string") {
    return { ok: false, error: "room_id is required" };
  }

  if (!payload.device_id || typeof payload.device_id !== "string") {
    return { ok: false, error: "device_id is required" };
  }

  return { ok: true };
}

function validateWifiConfig(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing payload object" };
  }

  if (payload.kind !== "wifi_config") {
    return { ok: false, error: `Unsupported config kind: ${payload.kind}` };
  }

  if (payload.version !== 1) {
    return { ok: false, error: `Unsupported config version: ${payload.version}` };
  }

  if (!payload.ssid || typeof payload.ssid !== "string") {
    return { ok: false, error: "ssid is required" };
  }

  if (typeof payload.password !== "string") {
    return { ok: false, error: "password is required" };
  }

  if (payload.security !== undefined && payload.security !== "wpa-psk") {
    return { ok: false, error: "Only security='wpa-psk' is currently supported" };
  }

  return { ok: true };
}

function validateCloudConfig(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Missing payload object" };
  }

  if (payload.kind !== "cloud_config") {
    return { ok: false, error: `Unsupported config kind: ${payload.kind}` };
  }

  if (payload.version !== 1) {
    return { ok: false, error: `Unsupported config version: ${payload.version}` };
  }

  if (!payload.endpoint_url || typeof payload.endpoint_url !== "string") {
    return { ok: false, error: "endpoint_url is required" };
  }

  if (!payload.shared_secret || typeof payload.shared_secret !== "string") {
    return { ok: false, error: "shared_secret is required" };
  }

  if (!payload.endpoint_url.startsWith("https://")) {
    return { ok: false, error: "endpoint_url must use https://" };
  }

  return { ok: true };
}

function updateEnvFile(updates) {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`.env file not found at ${ENV_PATH}`);
  }

  const original = fs.readFileSync(ENV_PATH, "utf8");
  const lines = original.split(/\r?\n/);

  const keysToUpdate = Object.keys(updates);
  const seenKeys = new Set();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      return line;
    }

    const eqIndex = line.indexOf("=");
    const key = line.slice(0, eqIndex).trim();

    if (keysToUpdate.includes(key)) {
      seenKeys.add(key);
      return `${key}=${updates[key]}`;
    }

    return line;
  });

  for (const key of keysToUpdate) {
    if (!seenKeys.has(key)) {
      newLines.push(`${key}=${updates[key]}`);
    }
  }

  fs.writeFileSync(ENV_PATH, newLines.join("\n"), "utf8");
}

function applyStationConfig(payload) {
  const validation = validateStationConfig(payload);
  if (!validation.ok) {
    return validation;
  }

  updateEnvFile({
    ROOM_ID: payload.room_id,
    STATION_ID: payload.station_id,
    DEVICE_ID: payload.device_id,
  });

  return {
    ok: true,
    kind: "station_config",
    applied: {
      ROOM_ID: payload.room_id,
      STATION_ID: payload.station_id,
      DEVICE_ID: payload.device_id,
    },
  };
}

function runCommand(command) {
  try {
    const output = execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.log("CMD OK:", command);
    if (output && output.trim()) {
      console.log("CMD OUT:", output.trim());
    }

    return output;
  } catch (err) {
    console.error("CMD FAILED:", command);

    if (err.stdout) {
      console.error("CMD STDOUT:", String(err.stdout).trim());
    }

    if (err.stderr) {
      console.error("CMD STDERR:", String(err.stderr).trim());
    }

    throw err;
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function applyWifiConfig(payload) {
  const validation = validateWifiConfig(payload);
  if (!validation.ok) {
    return validation;
  }

  const ssid = payload.ssid.trim();
  const password = payload.password;
  const security = payload.security || "wpa-psk";

  try {
    try {
      runCommand(
        `sudo /usr/bin/nmcli connection delete ${shellEscape(
          WIFI_CONNECTION_NAME
        )}`
      );
    } catch (err) {
      // OK if it does not exist yet
    }

    runCommand(
      [
        "sudo /usr/bin/nmcli connection add",
        "type wifi",
        `ifname ${WIFI_INTERFACE}`,
        `con-name ${shellEscape(WIFI_CONNECTION_NAME)}`,
        `ssid ${shellEscape(ssid)}`,
      ].join(" ")
    );

    if (security === "wpa-psk") {
      runCommand(
        [
          `sudo /usr/bin/nmcli connection modify ${shellEscape(
            WIFI_CONNECTION_NAME
          )}`,
          "wifi-sec.key-mgmt wpa-psk",
          `wifi-sec.psk ${shellEscape(password)}`,
          "connection.autoconnect yes",
        ].join(" ")
      );
    }

    console.log("WIFI CONFIG APPLIED; network may disconnect briefly...");

    runCommand(
      `sudo /usr/bin/nmcli connection up ${shellEscape(WIFI_CONNECTION_NAME)}`
    );

    return {
      ok: true,
      kind: "wifi_config",
      applied: {
        ssid,
        security,
        connection_name: WIFI_CONNECTION_NAME,
        interface: WIFI_INTERFACE,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to apply WiFi config: ${err.message}`,
    };
  }
}

function applyCloudConfig(payload) {
  const validation = validateCloudConfig(payload);
  if (!validation.ok) {
    return validation;
  }

  updateEnvFile({
    ENDPOINT_URL: payload.endpoint_url,
    SHARED_SECRET: payload.shared_secret,
  });

  return {
    ok: true,
    kind: "cloud_config",
    applied: {
      ENDPOINT_URL: payload.endpoint_url,
      SHARED_SECRET: payload.shared_secret,
    },
    runtime: {
      ENDPOINT_URL: payload.endpoint_url,
      SHARED_SECRET: payload.shared_secret,
    },
  };
}

function handleConfigQr(rawValue) {
  const parsed = parseConfigQr(rawValue);
  if (!parsed.ok) {
    return parsed;
  }

  const payload = parsed.payload;

  if (payload.kind === "station_config") {
    return applyStationConfig(payload);
  }

  if (payload.kind === "wifi_config") {
    return applyWifiConfig(payload);
  }

  if (payload.kind === "cloud_config") {
    return applyCloudConfig(payload);
  }

  return {
    ok: false,
    error: `Unsupported config kind: ${payload.kind}`,
  };
}

module.exports = {
  isConfigQr,
  parseConfigQr,
  validateStationConfig,
  validateWifiConfig,
  validateCloudConfig,
  applyStationConfig,
  applyWifiConfig,
  applyCloudConfig,
  handleConfigQr,
};