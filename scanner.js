require("dotenv").config();

const fs = require("fs");
const { spawn, execFile } = require("child_process");
const http = require("http");
const https = require("https");

const { isConfigQr, handleConfigQr } = require("./configQr");

// =========================
// CONFIG
// =========================

const SCANNER_DEVICE_NAME =
  process.env.SCANNER_DEVICE_NAME || "BF SCAN SCAN KEYBOARD";

let ENDPOINT_URL =
  process.env.ENDPOINT_URL ||
  "https://us-central1-alfarero-478ad.cloudfunctions.net/receiveRoomScanEvent";

let LOCAL_DISPLAY_URL =
  process.env.LOCAL_DISPLAY_URL || "http://127.0.0.1:3001/api/display";

let SHARED_SECRET = process.env.SHARED_SECRET || "";
let ROOM_ID = process.env.ROOM_ID || "reg_room_1";
let STATION_ID = process.env.STATION_ID || "reg";
let DEVICE_ID = process.env.DEVICE_ID || "scanner_pi_01";

if (!SHARED_SECRET) {
  throw new Error("Missing SHARED_SECRET environment variable");
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
// LOCAL DISPLAY
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

  try {
    const result = await postJson(LOCAL_DISPLAY_URL, { display });

    if (!result.statusCode || result.statusCode >= 300) {
      console.error("DISPLAY POST FAILED:", result.statusCode, result.body);
      return;
    }

    console.log("DISPLAY POST OK:", result.statusCode);
  } catch (err) {
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
// DISPLAY SYNC
// =========================

async function syncDisplayFromCloud(reason = "manual_sync", delayMs = 3000) {
  console.log(`==== DISPLAY SYNC: ${reason} ====`);

  if (delayMs > 0) {
    await delay(delayMs);
  }

  const payloadObj = {
    visit_id: null,
    raw_scan_value: null,
    room_id: ROOM_ID,
    station_id: STATION_ID,
    device_id: DEVICE_ID,
    event_type: "boot_sync",
    source_type: "PI_SCANNER",
    device_timestamp_utc: new Date().toISOString(),
  };

  console.log("DISPLAY SYNC PAYLOAD:", payloadObj);

  try {
    const result = await postJson(ENDPOINT_URL, payloadObj, {
      Authorization: `Bearer ${SHARED_SECRET}`,
    });

    console.log("DISPLAY SYNC STATUS:", result.statusCode);

    if (result.body) {
      console.log("DISPLAY SYNC BODY:", result.body);
    }

    if (!result.body) return;

    let parsed;
    try {
      parsed = JSON.parse(result.body);
    } catch (err) {
      console.error("DISPLAY SYNC JSON PARSE ERROR:", err.message);
      return;
    }

    if (parsed.display) {
      console.log("DISPLAY SYNC RECEIVED");
      await sendDisplayToKiosk(parsed.display);
    } else {
      console.log("DISPLAY SYNC: no display payload returned");
    }
  } catch (err) {
    console.error("DISPLAY SYNC ERROR:", err.message);
  }
}

// =========================
// CONFIG QR HANDLING
// =========================

async function handleConfigScan(scanValue) {
  let result;

  try {
    result = handleConfigQr(scanValue);
  } catch (err) {
    console.error("CONFIG QR ERROR: Exception while parsing config QR");
    console.error(err);
    return true;
  }

  if (!result || !result.ok) {
    console.error(
      "CONFIG QR ERROR:",
      result && result.error ? result.error : "Unknown config QR failure"
    );
    return true;
  }

  if (result.kind === "station_config") {
    console.log("CONFIG QR APPLIED:", result.applied);

    if (result.applied.ROOM_ID) ROOM_ID = result.applied.ROOM_ID;
    if (result.applied.STATION_ID) STATION_ID = result.applied.STATION_ID;
    if (result.applied.DEVICE_ID) DEVICE_ID = result.applied.DEVICE_ID;

    console.log("UPDATED CONFIG:");
    console.log("ROOM_ID =", ROOM_ID);
    console.log("STATION_ID =", STATION_ID);
    console.log("DEVICE_ID =", DEVICE_ID);

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
      console.error("WIFI CONFIG ERROR: Failed to apply WiFi config");
      console.error(err.stderr || err.message || err);
    }

    return true;
  }

  if (result.kind === "cloud_config") {
    console.log("CLOUD CONFIG APPLIED:", result.applied);

    if (result.runtime && result.runtime.ENDPOINT_URL) {
      ENDPOINT_URL = result.runtime.ENDPOINT_URL;
    }

    if (result.runtime && result.runtime.SHARED_SECRET) {
      SHARED_SECRET = result.runtime.SHARED_SECRET;
    }

    console.log("UPDATED CLOUD CONFIG:");
    console.log("ENDPOINT_URL =", ENDPOINT_URL);
    console.log("SHARED_SECRET = [REDACTED]");

    setTimeout(() => {
      syncDisplayFromCloud("cloud_config", 0);
    }, 2500);

    return true;
  }

  console.error("CONFIG QR ERROR: Unknown result kind");
  return true;
}

// =========================
// BUILD PAYLOAD
// =========================

function buildPayload(scanValue) {
  const visitId = scanValue.replace(/^VISIT:/, "");

  return {
    visit_id: visitId,
    raw_scan_value: scanValue,
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

  console.log("POST PAYLOAD:", payloadObj);

  try {
    const result = await postJson(ENDPOINT_URL, payloadObj, {
      Authorization: `Bearer ${SHARED_SECRET}`,
    });

    console.log("POST STATUS:", result.statusCode);

    if (result.body) {
      console.log("POST BODY:", result.body);
    }

    if (!result.body) return;

    let parsed;
    try {
      parsed = JSON.parse(result.body);
    } catch (err) {
      console.error("POST BODY JSON PARSE ERROR:", err.message);
      return;
    }

    if (parsed.display) {
      await sendDisplayToKiosk(parsed.display);
    }
  } catch (err) {
    console.error("POST ERROR:", err.message);
  }
}

// =========================
// MAIN
// =========================

function startScannerListener() {
  const devicePath = resolveScannerDevicePath();

  let scanBuffer = "";
  let lineRemainder = "";
  let shiftActive = false;

  const evtest = spawn("sudo", ["evtest", devicePath]);

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
    console.error(`evtest exited with code ${code}`);
  });

  evtest.on("error", (err) => {
    console.error("Failed to start evtest:", err);
  });

  console.log("Listening for scans...");
  console.log(`POST target: ${ENDPOINT_URL}`);
  console.log(`Local display target: ${LOCAL_DISPLAY_URL}`);
}

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

async function main() {
  await syncDisplayFromCloud("boot", 3000);
  startScannerListener();
}

main();