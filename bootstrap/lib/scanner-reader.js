"use strict";

/**
 * Scanner Reader — Multimedica Scanner Bootstrap Layer
 *
 * Reads USB barcode scanner events via `sudo evtest` on Linux.
 * Decodes keystroke events into scan strings and invokes onScan(rawString)
 * for every complete scan (terminated by KEY_ENTER).
 *
 * On non-Linux platforms start() logs a warning and returns immediately —
 * the controller continues without scanner input (useful for local testing).
 *
 * On scanner disconnect, the reader retries after SCANNER_RETRY_MS.
 */

const { spawn } = require("child_process");
const fs = require("fs");

const SCANNER_DEVICE_NAME = process.env.SCANNER_DEVICE_NAME || "BF SCAN SCAN KEYBOARD";
const SCANNER_RETRY_MS = Number(process.env.SCANNER_RETRY_MS || 5_000);

// ---------------------------------------------------------------------------
// Key map
// ---------------------------------------------------------------------------

const DIGIT_MAP = {
  KEY_0: { normal: "0", shifted: ")" },
  KEY_1: { normal: "1", shifted: "!" },
  KEY_2: { normal: "2", shifted: "@" },
  KEY_3: { normal: "3", shifted: "#" },
  KEY_4: { normal: "4", shifted: "$" },
  KEY_5: { normal: "5", shifted: "%" },
  KEY_6: { normal: "6", shifted: "^" },
  KEY_7: { normal: "7", shifted: "&" },
  KEY_8: { normal: "8", shifted: "*" },
  KEY_9: { normal: "9", shifted: "(" },
};

const SYMBOL_MAP = {
  KEY_MINUS: { normal: "-", shifted: "_" },
  KEY_EQUAL: { normal: "=", shifted: "+" },
  KEY_LEFTBRACE: { normal: "[", shifted: "{" },
  KEY_RIGHTBRACE: { normal: "]", shifted: "}" },
  KEY_SEMICOLON: { normal: ";", shifted: ":" },
  KEY_APOSTROPHE: { normal: "'", shifted: '"' },
  KEY_GRAVE: { normal: "`", shifted: "~" },
  KEY_BACKSLASH: { normal: "\\", shifted: "|" },
  KEY_COMMA: { normal: ",", shifted: "<" },
  KEY_DOT: { normal: ".", shifted: ">" },
  KEY_SLASH: { normal: "/", shifted: "?" },
  KEY_SPACE: { normal: " ", shifted: " " },
};

function keyToCharacter(key, shiftActive) {
  if (/^KEY_[A-Z]$/.test(key)) {
    const letter = key.slice(4); // 'KEY_A' → 'A'
    return shiftActive ? letter : letter.toLowerCase();
  }
  if (DIGIT_MAP[key]) {
    return shiftActive ? DIGIT_MAP[key].shifted : DIGIT_MAP[key].normal;
  }
  if (SYMBOL_MAP[key]) {
    return shiftActive ? SYMBOL_MAP[key].shifted : SYMBOL_MAP[key].normal;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device discovery
// ---------------------------------------------------------------------------

function findInputDeviceByName(targetName) {
  const devicesPath = "/proc/bus/input/devices";
  if (!fs.existsSync(devicesPath)) {
    throw new Error(`Input devices file not found: ${devicesPath}`);
  }
  const blocks = fs.readFileSync(devicesPath, "utf8").split(/\n\s*\n/);
  for (const block of blocks) {
    const nameMatch = block.match(/N:\s+Name="([^"]+)"/);
    if (!nameMatch || nameMatch[1] !== targetName) continue;
    const handlersMatch = block.match(/H:\s+Handlers=([^\n]+)/);
    if (!handlersMatch) throw new Error(`Device "${targetName}": no Handlers line`);
    const evMatch = handlersMatch[1].match(/\b(event\d+)\b/);
    if (!evMatch) throw new Error(`Device "${targetName}": no event handler`);
    return `/dev/input/${evMatch[1]}`;
  }
  throw new Error(`Input device not found: "${targetName}"`);
}

// ---------------------------------------------------------------------------
// Reader loop
// ---------------------------------------------------------------------------

/**
 * Start the scanner reader.
 * Calls onScan(rawString) for each complete scan.
 * Retries automatically on disconnect.
 *
 * @param {function(string): void|Promise<void>} onScan
 */
function start(onScan) {
  if (process.platform !== "linux") {
    console.warn("[scanner-reader] non-Linux platform; scanner reader not started");
    return Promise.resolve();
  }

  return _startLoop(onScan);
}

function _startLoop(onScan) {
  return new Promise((resolve) => {
    let devicePath;
    try {
      devicePath = findInputDeviceByName(SCANNER_DEVICE_NAME);
    } catch (err) {
      console.error(
        "[scanner-reader] device not found:",
        err.message,
        `— retrying in ${SCANNER_RETRY_MS}ms`
      );
      setTimeout(() => _startLoop(onScan).then(resolve), SCANNER_RETRY_MS);
      return;
    }

    console.log("[scanner-reader] listening on", devicePath);

    let scanBuffer = "";
    let lineRemainder = "";
    let shiftActive = false;

    const evtest = spawn("sudo", ["evtest", devicePath]);

    function handleLine(line) {
      if (!line.includes("EV_KEY")) return;
      const m = line.match(/\((KEY_[A-Z0-9_]+)\), value ([012])/);
      if (!m) return;
      const key = m[1];
      const val = Number(m[2]);
      if (key === "KEY_LEFTSHIFT" || key === "KEY_RIGHTSHIFT") {
        shiftActive = val === 1;
        return;
      }
      if (val !== 1) return;
      if (key === "KEY_ENTER") {
        if (scanBuffer.length > 0) {
          const scan = scanBuffer;
          scanBuffer = "";
          Promise.resolve(onScan(scan)).catch((err) => {
            console.error("[scanner-reader] onScan handler error:", err.message);
          });
        }
        return;
      }
      const ch = keyToCharacter(key, shiftActive);
      if (ch !== null) scanBuffer += ch;
    }

    evtest.stdout.on("data", (data) => {
      lineRemainder += data.toString();
      const lines = lineRemainder.split("\n");
      lineRemainder = lines.pop() || "";
      lines.forEach(handleLine);
    });

    evtest.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) console.log("[scanner-reader] evtest:", text);
    });

    evtest.on("close", (code) => {
      console.error(
        `[scanner-reader] evtest exited (code ${code}) — retrying in ${SCANNER_RETRY_MS}ms`
      );
      setTimeout(() => _startLoop(onScan).then(resolve), SCANNER_RETRY_MS);
    });
  });
}

module.exports = { start, findInputDeviceByName, keyToCharacter };
