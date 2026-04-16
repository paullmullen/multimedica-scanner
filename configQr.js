const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");

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
    applied: {
      ROOM_ID: payload.room_id,
      STATION_ID: payload.station_id,
      DEVICE_ID: payload.device_id,
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

  return {
    ok: false,
    error: `Unsupported config kind: ${payload.kind}`,
  };
}

module.exports = {
  isConfigQr,
  parseConfigQr,
  validateStationConfig,
  applyStationConfig,
  handleConfigQr,
};