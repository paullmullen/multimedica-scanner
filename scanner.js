const fs = require("fs");
const { spawn } = require("child_process");
const https = require("https");

// =========================
// CONFIG
// =========================

// =========================
// CONFIG (from .env via systemd)
// =========================

const SCANNER_DEVICE_NAME =
  process.env.SCANNER_DEVICE_NAME || "BF SCAN SCAN KEYBOARD";

const ENDPOINT_URL =
  process.env.ENDPOINT_URL ||
  "https://us-central1-alfarero-478ad.cloudfunctions.net/receiveRoomScanEvent";

const SHARED_SECRET = process.env.SHARED_SECRET || "";

const ROOM_ID = process.env.ROOM_ID || "reg_room_1";
const STATION_ID = process.env.STATION_ID || "reg";
const DEVICE_ID = process.env.DEVICE_ID || "scanner_pi_01";

// Fail fast if secret is missing
if (!SHARED_SECRET) {
  throw new Error("Missing SHARED_SECRET environment variable");
}

// =========================
// KEY MAPS
// =========================

const digitMap = {
  KEY_1: "1",
  KEY_2: "2",
  KEY_3: "3",
  KEY_4: "4",
  KEY_5: "5",
  KEY_6: "6",
  KEY_7: "7",
  KEY_8: "8",
  KEY_9: "9",
  KEY_0: "0",
};

const punctuationMap = {
  KEY_MINUS: "-",
  KEY_DOT: ".",
  KEY_SLASH: "/",
  KEY_SPACE: " ",
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
    return digitMap[key];
  }

  if (key === "KEY_SEMICOLON") {
    return shiftActive ? ":" : ";";
  }

  if (punctuationMap[key]) {
    return punctuationMap[key];
  }

  return null;
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
// POST FUNCTION
// =========================

function postScan(scanValue) {
  const payloadObj = buildPayload(scanValue);
  const payload = JSON.stringify(payloadObj);

  const endpoint = new URL(ENDPOINT_URL);

  console.log("POST PAYLOAD:", payloadObj);

  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    Authorization: `Bearer ${SHARED_SECRET}`,
  };

  const req = https.request(
    {
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      path: endpoint.pathname + endpoint.search,
      method: "POST",
      headers,
    },
    (res) => {
      let body = "";

      res.on("data", (chunk) => {
        body += chunk.toString();
      });

      res.on("end", () => {
        console.log("POST STATUS:", res.statusCode);

        if (body) {
          console.log("POST BODY:", body);
        }
      });
    }
  );

  req.on("error", (err) => {
    console.error("POST ERROR:", err.message);
  });

  req.write(payload);
  req.end();
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
        postScan(scanBuffer);
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
}

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

startScannerListener();