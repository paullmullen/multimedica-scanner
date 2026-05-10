require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const http = require("http");
const https = require("https");
const express = require("express");

const { isConfigQr, handleConfigQr } = require("./configQr");

// =========================
// CONFIG
// =========================

const SCANNER_DEVICE_NAME =
  process.env.SCANNER_DEVICE_NAME || "BF SCAN SCAN KEYBOARD";

const SCANNER_STATUS_PORT = Number(process.env.SCANNER_STATUS_PORT || 3002);

let ENDPOINT_URL =
  process.env.ENDPOINT_URL ||
  "https://us-central1-alfarero-478ad.cloudfunctions.net/receiveRoomScanEvent";

let SYNC_ENDPOINT_URL =
  process.env.SYNC_ENDPOINT_URL ||
  ENDPOINT_URL.replace("receiveRoomScanEvent", "syncStationDisplayState");

let LOCAL_DISPLAY_URL =
  process.env.LOCAL_DISPLAY_URL || "http://127.0.0.1:3001/api/display";

let SHARED_SECRET = process.env.SHARED_SECRET || "";
let ROOM_ID = process.env.ROOM_ID || "reg_room_1";
let STATION_ID = process.env.STATION_ID || "reg";
let DEVICE_ID = process.env.DEVICE_ID || "scanner_pi_01";
let LOCATION_ID = process.env.LOCATION_ID || "";

if (!SHARED_SECRET) {
  throw new Error("Missing SHARED_SECRET environment variable");
}

if (!LOCATION_ID) {
  console.warn(
    "WARNING: LOCATION_ID is not configured. Display sync will not be location-scoped."
  );
}

// =========================
// OBSERVABILITY / HEALTH
// =========================

const STARTED_AT = new Date().toISOString();

const health = {
  ok: true,
  service: "multimedica-scanner",
  status_version: 1,
  started_at: STARTED_AT,

  process: {
    pid: process.pid,
    node_version: process.version,
    uptime_seconds: 0,
  },

  config: {
    scanner_status_port: SCANNER_STATUS_PORT,
    scanner_device_name: SCANNER_DEVICE_NAME,
    endpoint_url: ENDPOINT_URL,
    sync_endpoint_url: SYNC_ENDPOINT_URL,
    local_display_url: LOCAL_DISPLAY_URL,
    room_id: ROOM_ID,
    station_id: STATION_ID,
    device_id: DEVICE_ID,
    location_id: LOCATION_ID || null,
    has_shared_secret: Boolean(SHARED_SECRET),
    has_admin_token: Boolean(process.env.SCANNER_QR_ADMIN_TOKEN),
  },

  scanner: {
    connected: false,
    device_name: SCANNER_DEVICE_NAME,
    device_path: null,
    evtest_running: false,
    evtest_exit_code: null,
    last_scan_at: null,
    last_scan_type: null,
    last_scan_result: null,
    last_scan_value_preview: null,
    last_error_at: null,
    last_error_message: null,
  },

  cloud: {
    endpoint_url: ENDPOINT_URL,
    sync_endpoint_url: SYNC_ENDPOINT_URL,
    last_post_at: null,
    last_post_status: null,
    last_success_at: null,
    last_error_at: null,
    last_error_message: null,
    last_response_preview: null,
  },

  display: {
    local_url: LOCAL_DISPLAY_URL,
    last_update_at: null,
    last_update_result: null,
    last_status_code: null,
    last_error_at: null,
    last_error_message: null,
  },

  polling: {
    enabled: true,
    active: false,
    in_flight: false,
    current_interval_ms: null,
    last_reason: null,
    last_poll_at: null,
    last_success_at: null,
    last_error_at: null,
    last_error_message: null,
  },

  config_qr: {
    last_config_at: null,
    last_kind: null,
    last_result: null,
    last_error_at: null,
    last_error_message: null,
  },

  wifi: {
    last_config_at: null,
    last_result: null,
    last_ssid: null,
    last_error_at: null,
    last_error_message: null,
  },
};

const LOCAL_HEALTH_URL = "http://127.0.0.1:3001/api/health";

async function postLocalHealth(healthPatch) {
  try {
    await fetch(LOCAL_HEALTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ health: healthPatch }),
    });
  } catch (error) {
    console.error("Failed to post local health:", error.message || error);
  }
}

async function markCloudHealthy(extra = {}) {
  await postLocalHealth({
    connectivity: "online",
    trust_level: "trusted",
    stale_level: "fresh",
    last_cloud_sync_at: Date.now(),
    last_error_at: null,
    last_error_message: null,
    ...extra,
  });
}

async function markCloudDegraded(error, extra = {}) {
  await postLocalHealth({
    connectivity: "offline",
    trust_level: "degraded",
    last_error_at: Date.now(),
    last_error_message: String(error?.message || error || "Cloud request failed"),
    ...extra,
  });
}

function nowIso() {
  return new Date().toISOString();
}

function previewValue(value, maxLength = 80) {
  if (value === null || value === undefined) return null;

  const text = String(value);
  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength)}…`;
}

function refreshRuntimeHealth() {
  health.ok =
    Boolean(health.scanner.connected) &&
    Boolean(health.config.has_shared_secret);

  health.process.uptime_seconds = Math.floor(process.uptime());

  health.config.endpoint_url = ENDPOINT_URL;
  health.config.sync_endpoint_url = SYNC_ENDPOINT_URL;
  health.config.local_display_url = LOCAL_DISPLAY_URL;
  health.config.room_id = ROOM_ID;
  health.config.station_id = STATION_ID;
  health.config.device_id = DEVICE_ID;
  health.config.location_id = LOCATION_ID || null;
  health.config.has_shared_secret = Boolean(SHARED_SECRET);
  health.config.has_admin_token = Boolean(process.env.SCANNER_QR_ADMIN_TOKEN);

  health.cloud.endpoint_url = ENDPOINT_URL;
  health.cloud.sync_endpoint_url = SYNC_ENDPOINT_URL;

  health.display.local_url = LOCAL_DISPLAY_URL;

  health.polling.in_flight = adaptivePollInFlight;
  health.polling.active = Boolean(adaptivePollTimer);
}

function buildStatusSummary() {
  refreshRuntimeHealth();

  const cloudOk =
    Boolean(health.cloud.last_success_at) &&
    !health.cloud.last_error_message;

  const displayOk =
    health.display.last_update_result === "success" &&
    !health.display.last_error_message;

  return {
    ok: health.ok,
    timestamp: nowIso(),
    service: health.service,
    uptime_seconds: health.process.uptime_seconds,

    station: health.config.station_id,
    room: health.config.room_id,
    device_id: health.config.device_id,
    location_id: health.config.location_id,

    scanner_connected: health.scanner.connected,
    evtest_running: health.scanner.evtest_running,

    cloud_ok: cloudOk,
    display_ok: displayOk,
    polling_active: health.polling.active,
    polling_interval_ms: health.polling.current_interval_ms,

    last_scan_at: health.scanner.last_scan_at,
    last_scan_type: health.scanner.last_scan_type,

    last_cloud_success_at: health.cloud.last_success_at,
    last_cloud_error_at: health.cloud.last_error_at,

    last_display_update_at: health.display.last_update_at,
    last_display_result: health.display.last_update_result,
  };
}

function buildStatusSummary() {
  refreshRuntimeHealth();

  const cloudOk =
    Boolean(health.cloud.last_success_at) &&
    !health.cloud.last_error_message;

  const displayOk =
    health.display.last_update_result === "success" &&
    !health.display.last_error_message;

  return {
    ok: health.ok,
    timestamp: nowIso(),
    service: health.service,
    uptime_seconds: health.process.uptime_seconds,

    station: health.config.station_id,
    room: health.config.room_id,
    device_id: health.config.device_id,
    location_id: health.config.location_id,

    scanner_connected: health.scanner.connected,
    evtest_running: health.scanner.evtest_running,

    cloud_ok: cloudOk,
    display_ok: displayOk,

    polling_active: health.polling.active,
    polling_interval_ms: health.polling.current_interval_ms,

    last_scan_at: health.scanner.last_scan_at,
    last_scan_type: health.scanner.last_scan_type,

    last_cloud_success_at: health.cloud.last_success_at,
    last_cloud_error_at: health.cloud.last_error_at,

    last_display_update_at: health.display.last_update_at,
    last_display_result: health.display.last_update_result,
  };
}

function startStatusServer() {
  const app = express();

  app.get("/api/status", (req, res) => {
    refreshRuntimeHealth();

    res.json({
      ok: health.ok,
      timestamp: nowIso(),
      uptime_seconds: health.process.uptime_seconds,
      health,
    });
  });

  app.get("/api/status/summary", (req, res) => {
    res.json(buildStatusSummary());
  });

  app.listen(SCANNER_STATUS_PORT, "127.0.0.1", () => {
    console.log(
      `STATUS SERVER LISTENING: http://127.0.0.1:${SCANNER_STATUS_PORT}/api/status`
    );
  });
}

// =========================
// COMMAND HELPERS
// =========================

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: options.timeout || 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject({
            error,
            stdout: stdout || "",
            stderr: stderr || "",
          });
          return;
        }

        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

async function runCommandAllowFailure(command, args, options = {}) {
  try {
    return await runCommand(command, args, options);
  } catch (err) {
    return {
      failed: true,
      error: err.error || err,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
}

async function applyWifiConfig({ ssid, password }) {
  if (!ssid) {
    throw new Error("Missing WiFi SSID");
  }

  if (password === undefined) {
    throw new Error("Missing WiFi password");
  }

  console.log("APPLYING WIFI CONFIG VIA sudo nmcli");
  console.log("WIFI SSID:", ssid);
  console.log("WIFI PASSWORD: [REDACTED]");

  health.wifi.last_config_at = nowIso();
  health.wifi.last_result = "in_progress";
  health.wifi.last_ssid = ssid;
  health.wifi.last_error_message = null;

  const existing = await runCommandAllowFailure("sudo", [
    "/usr/bin/nmcli",
    "-t",
    "-f",
    "UUID,NAME,TYPE",
    "connection",
    "show",
  ]);

  if (!existing.failed && existing.stdout.trim()) {
    const matchingUuids = existing.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [uuid, name, type] = line.split(":");
        return { uuid, name, type };
      })
      .filter((conn) => conn.name === ssid && conn.type === "802-11-wireless")
      .map((conn) => conn.uuid)
      .filter(Boolean);

    for (const uuid of matchingUuids) {
      console.log("DELETING EXISTING WIFI CONNECTION:", uuid);
      await runCommandAllowFailure("sudo", [
        "/usr/bin/nmcli",
        "connection",
        "delete",
        uuid,
      ]);
    }
  }

  await runCommand("sudo", [
    "/usr/bin/nmcli",
    "connection",
    "add",
    "type",
    "wifi",
    "ifname",
    "wlan0",
    "con-name",
    ssid,
    "ssid",
    ssid,
  ]);

  await runCommand("sudo", [
    "/usr/bin/nmcli",
    "connection",
    "modify",
    ssid,
    "wifi-sec.key-mgmt",
    "wpa-psk",
  ]);

  await runCommand("sudo", [
    "/usr/bin/nmcli",
    "connection",
    "modify",
    ssid,
    "wifi-sec.psk",
    password,
  ]);

  await runCommand("sudo", [
    "/usr/bin/nmcli",
    "connection",
    "modify",
    ssid,
    "connection.autoconnect",
    "yes",
  ]);

  const result = await runCommand(
    "sudo",
    ["/usr/bin/nmcli", "connection", "up", ssid],
    { timeout: 60000 }
  );

  health.wifi.last_result = "success";
  health.wifi.last_error_message = null;

  if (result.stdout.trim()) {
    console.log("NMCLI STDOUT:", result.stdout.trim());
  }

  if (result.stderr.trim()) {
    console.log("NMCLI STDERR:", result.stderr.trim());
  }
}

// =========================
// KEY MAPS
// =========================

const digitMap = {
  KEY_1: { normal: "1", shifted: "!" },
  KEY_2: { normal: "2", shifted: "@" },
  KEY_3: { normal: "3", shifted: "#" },
  KEY_4: { normal: "4", shifted: "$" },
  KEY_5: { normal: "5", shifted: "%" },
  KEY_6: { normal: "6", shifted: "^" },
  KEY_7: { normal: "7", shifted: "&" },
  KEY_8: { normal: "8", shifted: "*" },
  KEY_9: { normal: "9", shifted: "(" },
  KEY_0: { normal: "0", shifted: ")" },
};

// =========================
// DEVICE DISCOVERY
// =========================

function findInputDeviceByName(targetName) {
  const inputDevicesPath = "/proc/bus/input/devices";

  if (!fs.existsSync(inputDevicesPath)) {
    throw new Error(`Input devices file not found: ${inputDevicesPath}`);
  }

  const content = fs.readFileSync(inputDevicesPath, "utf8");
  const blocks = content.split(/\n\s*\n/);

  for (const block of blocks) {
    const nameMatch = block.match(/N:\s+Name="([^"]+)"/);
    if (!nameMatch) continue;

    const deviceName = nameMatch[1];
    if (deviceName !== targetName) continue;

    const handlersMatch = block.match(/H:\s+Handlers=([^\n]+)/);
    if (!handlersMatch) {
      throw new Error(
        `Found device "${targetName}" but no Handlers line was present.`
      );
    }

    const handlers = handlersMatch[1];
    const eventMatch = handlers.match(/\b(event\d+)\b/);

    if (!eventMatch) {
      throw new Error(
        `Found device "${targetName}" but no event handler was present.`
      );
    }

    return `/dev/input/${eventMatch[1]}`;
  }

  throw new Error(`Could not find input device with name "${targetName}"`);
}

function resolveScannerDevicePath() {
  const devicePath = findInputDeviceByName(SCANNER_DEVICE_NAME);

  health.scanner.connected = true;
  health.scanner.device_name = SCANNER_DEVICE_NAME;
  health.scanner.device_path = devicePath;
  health.scanner.last_error_message = null;

  console.log(`Scanner device name: ${SCANNER_DEVICE_NAME}`);
  console.log(`Resolved device path: ${devicePath}`);
  return devicePath;
}

// =========================
// KEY PARSING
// =========================

function keyToCharacter(key, shiftActive) {
  if (/^KEY_[A-Z]$/.test(key)) {
    const letter = key.replace("KEY_", "");
    return shiftActive ? letter : letter.toLowerCase();
  }

  if (digitMap[key]) {
    return shiftActive ? digitMap[key].shifted : digitMap[key].normal;
  }

  switch (key) {
    case "KEY_SEMICOLON":
      return shiftActive ? ":" : ";";
    case "KEY_MINUS":
      return shiftActive ? "_" : "-";
    case "KEY_DOT":
      return shiftActive ? ">" : ".";
    case "KEY_SLASH":
      return shiftActive ? "?" : "/";
    case "KEY_SPACE":
      return " ";
    case "KEY_COMMA":
      return shiftActive ? "<" : ",";
    case "KEY_APOSTROPHE":
      return shiftActive ? '"' : "'";
    case "KEY_LEFTBRACE":
      return shiftActive ? "{" : "[";
    case "KEY_RIGHTBRACE":
      return shiftActive ? "}" : "]";
    case "KEY_EQUAL":
      return shiftActive ? "+" : "=";
    case "KEY_BACKSLASH":
      return shiftActive ? "|" : "\\";
    case "KEY_GRAVE":
      return shiftActive ? "~" : "`";
    default:
      return null;
  }
}

// =========================
// LOCAL DISPLAY / HTTP
// =========================

function postJson(urlString, payloadObj, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(payloadObj);
    const endpoint = new URL(urlString);
    const client = endpoint.protocol === "https:" ? https : http;

    const req = client.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
        path: endpoint.pathname + endpoint.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let body = "";

        res.on("data", (chunk) => {
          body += chunk.toString();
        });

        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body,
          });
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function buildConfiguredStationDisplay() {
  return {
    mode: "room_status",
    room: { label: ROOM_ID || "—" },
    station: { label: STATION_ID || "—" },
    status: { code: "available", label: "DISPONIBLE" },
    patient: { name: "—" },
    timing: { started_at: null },
    updated_at: Date.now(),
  };
}

async function sendDisplayToKiosk(display) {
  if (!display) return;

  health.display.last_update_at = nowIso();

  try {
    const result = await postJson(LOCAL_DISPLAY_URL, { display });

    health.display.last_status_code = result.statusCode;

    if (!result.statusCode || result.statusCode >= 300) {
      health.display.last_update_result = "error";
      health.display.last_error_at = nowIso();
      health.display.last_error_message = `HTTP ${result.statusCode}: ${previewValue(
        result.body,
        160
      )}`;

      console.error("DISPLAY POST FAILED:", result.statusCode, result.body);
      return;
    }

    health.display.last_update_result = "success";
    health.display.last_error_message = null;

    console.log("DISPLAY POST OK:", result.statusCode);
  } catch (err) {
    health.display.last_update_result = "error";
    health.display.last_error_at = nowIso();
    health.display.last_error_message = err.message;

    console.error("DISPLAY POST ERROR:", err.message);
  }
}

async function showStationConfigConfirmation() {
  await sendDisplayToKiosk({
    mode: "overlay",
    overlay: {
      type: "success",
      title: "Configuración actualizada",
      message: `Estación: ${STATION_ID.toUpperCase()}`,
    },
    room: { label: ROOM_ID || "—" },
    station: { label: STATION_ID || "—" },
    updated_at: Date.now(),
  });

  setTimeout(() => {
    sendDisplayToKiosk(buildConfiguredStationDisplay());
  }, 2000);
}

// =========================
// ADAPTIVE POLLING
// =========================

let adaptivePollTimer = null;
let adaptivePollInFlight = false;

const MIN_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 30000;
const MAX_POLL_INTERVAL_MS = 300000;

function cancelAdaptivePolling(reason = "cancel") {
  if (adaptivePollTimer) {
    clearTimeout(adaptivePollTimer);
    adaptivePollTimer = null;
  }

  health.polling.active = false;
  health.polling.current_interval_ms = null;
  health.polling.last_reason = reason;

  console.log(`ADAPTIVE POLLING STOPPED: ${reason}`);
}

function clampPollInterval(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_POLL_INTERVAL_MS;
  }

  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, n));
}

function scheduleAdaptivePoll(intervalMs, reason = "unspecified") {
  if (adaptivePollTimer) {
    clearTimeout(adaptivePollTimer);
    adaptivePollTimer = null;
  }

  const safeInterval = clampPollInterval(intervalMs);

  health.polling.enabled = true;
  health.polling.active = true;
  health.polling.current_interval_ms = safeInterval;
  health.polling.last_reason = reason;

  console.log(`ADAPTIVE POLLING SCHEDULED: ${safeInterval}ms reason=${reason}`);

  adaptivePollTimer = setTimeout(() => {
    adaptivePollTimer = null;
    health.polling.active = false;
    syncDisplayFromCloud("adaptive_poll", 0);
  }, safeInterval);
}

function applyPollingInstruction(polling, sourceReason = "unknown") {
  if (!polling || polling.should_poll !== true) {
    cancelAdaptivePolling(
      polling && polling.reason
        ? polling.reason
        : `cloud_said_stop_after_${sourceReason}`
    );
    return;
  }

  scheduleAdaptivePoll(
    polling.recommended_interval_ms,
    polling.reason || sourceReason
  );
}

function extractDisplayFromCloudResponse(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  return parsed.display || parsed.state || parsed.room_status || null;
}

async function applyCloudDisplayResponse(
  parsed,
  sourceReason = "unknown",
  options = {}
) {
  const display = extractDisplayFromCloudResponse(parsed);

  if (display) {
    console.log(`DISPLAY RECEIVED FROM CLOUD: ${sourceReason}`);
    await sendDisplayToKiosk(display);
  } else {
    console.log(`NO DISPLAY PAYLOAD FROM CLOUD: ${sourceReason}`);
  }

  if (parsed && parsed.polling) {
    applyPollingInstruction(parsed.polling, sourceReason);
    return;
  }

  if (options.fetchPollingIfMissing) {
    console.log(
      `POLLING INSTRUCTION MISSING AFTER ${sourceReason}; FETCHING SYNC STATE`
    );
    syncDisplayFromCloud(`${sourceReason}_polling_followup`, 0);
  }
}

// =========================
// DISPLAY SYNC
// =========================

async function syncDisplayFromCloud(reason = "manual_sync", delayMs = 3000) {
  console.log(`==== DISPLAY SYNC: ${reason} ====`);

  health.polling.last_poll_at = nowIso();
  health.polling.last_reason = reason;

  if (delayMs > 0) {
    await delay(delayMs);
  }

  if (adaptivePollInFlight) {
    console.log("DISPLAY SYNC SKIPPED: already in flight");
    return;
  }

  adaptivePollInFlight = true;
  health.polling.in_flight = true;

  const payloadObj = {
    location_id: LOCATION_ID || null,
    room_id: ROOM_ID,
    station_id: STATION_ID,
    device_id: DEVICE_ID,
    reason,
    source_type: "PI_SCANNER",
    device_timestamp_utc: new Date().toISOString(),
  };

  console.log("DISPLAY SYNC TARGET:", SYNC_ENDPOINT_URL);
  console.log("DISPLAY SYNC PAYLOAD:", payloadObj);

  try {
    const result = await postJson(SYNC_ENDPOINT_URL, payloadObj, {
      Authorization: `Bearer ${SHARED_SECRET}`,
    });

    health.cloud.last_post_at = nowIso();
    health.cloud.last_post_status = result.statusCode;
    health.cloud.last_response_preview = previewValue(result.body, 300);

    console.log("DISPLAY SYNC STATUS:", result.statusCode);

    if (result.body) {
      console.log("DISPLAY SYNC BODY:", result.body);
    }

    if (!result.statusCode || result.statusCode >= 300) {
      health.polling.last_error_at = nowIso();
      health.polling.last_error_message = `HTTP ${result.statusCode}`;
      health.cloud.last_error_at = nowIso();
      health.cloud.last_error_message = `DISPLAY SYNC HTTP ${result.statusCode}`;

      await markCloudDegraded(`DISPLAY SYNC HTTP ${result.statusCode}`);
    } else {
      health.polling.last_success_at = nowIso();
      health.polling.last_error_message = null;
      health.cloud.last_success_at = nowIso();
      health.cloud.last_error_message = null;

      await markCloudHealthy({
        operational_mode: "active",
      });
    }

    if (!result.body) return;

    let parsed;
    try {
      parsed = JSON.parse(result.body);
    } catch (err) {
      health.polling.last_error_at = nowIso();
      health.polling.last_error_message = `JSON parse error: ${err.message}`;
      health.cloud.last_error_at = nowIso();
      health.cloud.last_error_message = `DISPLAY SYNC JSON parse error: ${err.message}`;

      console.error("DISPLAY SYNC JSON PARSE ERROR:", err.message);
      return;
    }

    await applyCloudDisplayResponse(parsed, reason, {
      fetchPollingIfMissing: false,
    });
  } catch (err) {
    health.polling.last_error_at = nowIso();
    health.polling.last_error_message = err.message;
    health.cloud.last_error_at = nowIso();
    health.cloud.last_error_message = `DISPLAY SYNC ERROR: ${err.message}`;

    await markCloudDegraded(err);

    console.error("DISPLAY SYNC ERROR:", err.message);

    scheduleAdaptivePoll(MAX_POLL_INTERVAL_MS, "sync_error_backoff");
  } finally {
    adaptivePollInFlight = false;
    health.polling.in_flight = false;
  }
}

// =========================
// CONFIG QR HANDLING
// =========================

async function handleConfigScan(scanValue) {
  let result;

  health.config_qr.last_config_at = nowIso();
  health.config_qr.last_result = "in_progress";
  health.config_qr.last_error_message = null;

  try {
    result = handleConfigQr(scanValue);
  } catch (err) {
    health.config_qr.last_result = "error";
    health.config_qr.last_error_at = nowIso();
    health.config_qr.last_error_message = err.message;

    console.error("CONFIG QR ERROR: Exception while parsing config QR");
    console.error(err);
    return true;
  }

  if (!result || !result.ok) {
    health.config_qr.last_result = "error";
    health.config_qr.last_error_at = nowIso();
    health.config_qr.last_error_message =
      result && result.error ? result.error : "Unknown config QR failure";

    console.error(
      "CONFIG QR ERROR:",
      result && result.error ? result.error : "Unknown config QR failure"
    );
    return true;
  }

  health.config_qr.last_kind = result.kind;
  health.config_qr.last_result = "success";
  health.config_qr.last_error_message = null;

  if (result.kind === "station_config") {
    console.log("CONFIG QR APPLIED:", result.applied);

    if (result.applied.ROOM_ID) ROOM_ID = result.applied.ROOM_ID;
    if (result.applied.STATION_ID) STATION_ID = result.applied.STATION_ID;
    if (result.applied.DEVICE_ID) DEVICE_ID = result.applied.DEVICE_ID;
    if (result.applied.LOCATION_ID) LOCATION_ID = result.applied.LOCATION_ID;

    health.config.room_id = ROOM_ID;
    health.config.station_id = STATION_ID;
    health.config.device_id = DEVICE_ID;
    health.config.location_id = LOCATION_ID || null;

    console.log("UPDATED CONFIG:");
    console.log("ROOM_ID =", ROOM_ID);
    console.log("STATION_ID =", STATION_ID);
    console.log("DEVICE_ID =", DEVICE_ID);
    console.log("LOCATION_ID =", LOCATION_ID || "[not set]");

    await showStationConfigConfirmation();

    setTimeout(() => {
      syncDisplayFromCloud("station_config", 0);
    }, 2500);

    return true;
  }

  if (result.kind === "wifi_config") {
    console.log("WIFI CONFIG QR VALIDATED:", result.applied);

    try {
      await applyWifiConfig(result.runtime);

      console.log("WIFI CONFIG APPLIED:", {
        SSID: result.runtime.ssid,
      });

      console.log(
        "The scanner may briefly lose connectivity while switching networks."
      );

      setTimeout(() => {
        syncDisplayFromCloud("wifi_config", 0);
      }, 8000);
    } catch (err) {
      health.wifi.last_result = "error";
      health.wifi.last_error_at = nowIso();
      health.wifi.last_error_message = err.stderr || err.message || String(err);

      console.error("WIFI CONFIG ERROR: Failed to apply WiFi config");
      console.error(err.stderr || err.message || err);
    }

    return true;
  }

  if (result.kind === "cloud_config") {
    console.log("CLOUD CONFIG APPLIED:", result.applied);

    if (result.runtime && result.runtime.ENDPOINT_URL) {
      ENDPOINT_URL = result.runtime.ENDPOINT_URL;
      SYNC_ENDPOINT_URL = ENDPOINT_URL.replace(
        "receiveRoomScanEvent",
        "syncStationDisplayState"
      );
    }

    if (result.runtime && result.runtime.SYNC_ENDPOINT_URL) {
      SYNC_ENDPOINT_URL = result.runtime.SYNC_ENDPOINT_URL;
    }

    if (result.runtime && result.runtime.SHARED_SECRET) {
      SHARED_SECRET = result.runtime.SHARED_SECRET;
    }

    health.config.endpoint_url = ENDPOINT_URL;
    health.config.sync_endpoint_url = SYNC_ENDPOINT_URL;
    health.config.has_shared_secret = Boolean(SHARED_SECRET);
    health.cloud.endpoint_url = ENDPOINT_URL;
    health.cloud.sync_endpoint_url = SYNC_ENDPOINT_URL;

    console.log("UPDATED CLOUD CONFIG:");
    console.log("ENDPOINT_URL =", ENDPOINT_URL);
    console.log("SYNC_ENDPOINT_URL =", SYNC_ENDPOINT_URL);
    console.log("SHARED_SECRET = [REDACTED]");

    setTimeout(() => {
      syncDisplayFromCloud("cloud_config", 0);
    }, 2500);

    return true;
  }

  health.config_qr.last_result = "error";
  health.config_qr.last_error_at = nowIso();
  health.config_qr.last_error_message = "Unknown result kind";

  console.error("CONFIG QR ERROR: Unknown result kind");
  return true;
}

// =========================
// BUILD PAYLOAD
// =========================

function buildPayload(scanValue) {
  const visitId = scanValue.replace(/^VISIT:/, "");

  return {
    event_id: crypto.randomUUID(),
    visit_id: visitId,
    raw_scan_value: scanValue,
    location_id: LOCATION_ID || null,
    room_id: ROOM_ID,
    station_id: STATION_ID,
    device_id: DEVICE_ID,
    event_type: "scan_received",
    source_type: "PI_SCANNER",
    device_timestamp_utc: new Date().toISOString(),
  };
}

// =========================
// POST SCAN TO CLOUD
// =========================

async function postScan(scanValue) {
  const payloadObj = buildPayload(scanValue);

  health.cloud.last_post_at = nowIso();
  health.cloud.last_post_status = null;
  health.cloud.last_error_message = null;

  console.log("POST TARGET:", ENDPOINT_URL);
  console.log("POST PAYLOAD:", payloadObj);

  try {
    const result = await postJson(ENDPOINT_URL, payloadObj, {
      Authorization: `Bearer ${SHARED_SECRET}`,
    });

    health.cloud.last_post_status = result.statusCode;
    health.cloud.last_response_preview = previewValue(result.body, 300);

    console.log("POST STATUS:", result.statusCode);

    if (result.body) {
      console.log("POST BODY:", result.body);
    }

    if (!result.statusCode || result.statusCode >= 300) {
      health.cloud.last_error_at = nowIso();
      health.cloud.last_error_message = `HTTP ${result.statusCode}`;

      await markCloudDegraded(`SCAN POST HTTP ${result.statusCode}`);
    } else {
      health.cloud.last_success_at = nowIso();
      health.cloud.last_error_message = null;

      await markCloudHealthy({
        operational_mode: "active",
      });
    }

    if (!result.body) return;

    let parsed;
    try {
      parsed = JSON.parse(result.body);
    } catch (err) {
      health.cloud.last_error_at = nowIso();
      health.cloud.last_error_message = `POST BODY JSON parse error: ${err.message}`;

      console.error("POST BODY JSON PARSE ERROR:", err.message);
      return;
    }

    await applyCloudDisplayResponse(parsed, "scan", {
      fetchPollingIfMissing: true,
    });
  } catch (err) {
    health.cloud.last_error_at = nowIso();
    health.cloud.last_error_message = err.message;

    await markCloudDegraded(err);

    console.error("POST ERROR:", err.message);
    scheduleAdaptivePoll(MAX_POLL_INTERVAL_MS, "post_scan_error_backoff");
  }
}

// =========================
// MAIN
// =========================

function startScannerListener() {
  let devicePath;

  try {
    devicePath = resolveScannerDevicePath();
  } catch (err) {
    health.scanner.connected = false;
    health.scanner.evtest_running = false;
    health.scanner.last_error_at = nowIso();
    health.scanner.last_error_message = err.message;

    throw err;
  }

  let scanBuffer = "";
  let lineRemainder = "";
  let shiftActive = false;

  const evtest = spawn("sudo", ["evtest", devicePath]);

  health.scanner.evtest_running = true;
  health.scanner.evtest_exit_code = null;

  function handleLine(line) {
    if (!line.includes("EV_KEY")) return;

    const match = line.match(/\((KEY_[A-Z0-9_]+)\), value ([012])/);
    if (!match) return;

    const key = match[1];
    const value = Number(match[2]);

    if (key === "KEY_LEFTSHIFT" || key === "KEY_RIGHTSHIFT") {
      shiftActive = value === 1;
      return;
    }

    if (value !== 1) return;

    if (key === "KEY_ENTER") {
      if (scanBuffer.length > 0) {
        console.log("SCAN:", scanBuffer);

        health.scanner.last_scan_at = nowIso();
        health.scanner.last_scan_value_preview = previewValue(scanBuffer, 80);
        health.scanner.last_scan_result = "received";
        health.scanner.last_scan_type = isConfigQr(scanBuffer)
          ? "config_qr"
          : scanBuffer.startsWith("VISIT:")
          ? "visit"
          : "unknown";

        if (isConfigQr(scanBuffer)) {
          console.log("==== CONFIG QR DETECTED ====");
          handleConfigScan(scanBuffer);
        } else {
          console.log("==== NORMAL SCAN ====");
          postScan(scanBuffer);
        }

        scanBuffer = "";
      }
      return;
    }

    const character = keyToCharacter(key, shiftActive);

    if (character !== null) {
      scanBuffer += character;
      return;
    }

    console.log("UNMAPPED:", key);
  }

  evtest.stdout.on("data", (data) => {
    lineRemainder += data.toString();

    const lines = lineRemainder.split("\n");
    lineRemainder = lines.pop() || "";

    lines.forEach(handleLine);
  });

  evtest.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) {
      console.log("EVTEST:", text);
    }
  });

  evtest.on("close", (code) => {
    health.scanner.connected = false;
    health.scanner.evtest_running = false;
    health.scanner.evtest_exit_code = code;
    health.scanner.last_error_at = nowIso();
    health.scanner.last_error_message = `evtest exited with code ${code}`;

    console.error(`evtest exited with code ${code}`);
  });

  evtest.on("error", (err) => {
    health.scanner.connected = false;
    health.scanner.evtest_running = false;
    health.scanner.last_error_at = nowIso();
    health.scanner.last_error_message = err.message;

    console.error("Failed to start evtest:", err);
  });

  console.log("Listening for scans...");
  console.log(`POST target: ${ENDPOINT_URL}`);
  console.log(`Display sync target: ${SYNC_ENDPOINT_URL}`);
  console.log(`Local display target: ${LOCAL_DISPLAY_URL}`);
  console.log(`LOCATION_ID: ${LOCATION_ID || "[not set]"}`);
}

process.on("uncaughtException", (err) => {
  health.ok = false;
  health.scanner.last_error_at = nowIso();
  health.scanner.last_error_message = `Uncaught Exception: ${err.message}`;

  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  health.ok = false;

  const message =
    reason && reason.message ? reason.message : JSON.stringify(reason);

  health.scanner.last_error_at = nowIso();
  health.scanner.last_error_message = `Unhandled Rejection: ${message}`;

  console.error("Unhandled Rejection:", reason);
});

async function main() {
  startStatusServer();

  await syncDisplayFromCloud("boot", 3000);

  startScannerListener();
}

main();