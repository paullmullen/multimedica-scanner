"use strict";

/**
 * Display Client — Multimedica Scanner Bootstrap Controller
 *
 * HTTP client that pushes commissioning state and operator messages to
 * the bootstrap display server at DISPLAY_URL (default :3001).
 *
 * All methods are best-effort: failures are logged at WARN level and do
 * not propagate — the controller must not crash because the display is
 * temporarily unavailable.
 *
 * SECRET VALUES MUST NEVER be passed to any function in this module.
 */

const http = require("http");

const DISPLAY_URL = process.env.DISPLAY_URL || "http://127.0.0.1:3001";
const TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

function _post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    let url;
    try {
      url = new URL(pathname, DISPLAY_URL);
    } catch {
      return reject(new Error(`Invalid DISPLAY_URL: ${DISPLAY_URL}${pathname}`));
    }

    const options = {
      hostname: url.hostname,
      port: Number(url.port) || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = http.request(options, (res) => {
      res.resume(); // drain response body
      resolve({ statusCode: res.statusCode });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error("display client timeout"));
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Push current commissioning state to the display server.
 * @param {{ state: string, complete: boolean, missing: string[] }} stateObj
 */
async function updateState(stateObj) {
  try {
    await _post("/api/state", {
      state: stateObj.state,
      configuration_complete: stateObj.configuration_complete,
      commissioning_complete: stateObj.commissioning_complete,
      release_installed: stateObj.release_installed,
      production_ready: stateObj.production_ready,
      missing: stateObj.missing,
    });
  } catch (err) {
    console.warn("[display-client] updateState failed:", err.message);
  }
}

/**
 * Push an operator message to the display server.
 * kind: 'success' | 'error' | 'applying' | 'info'
 * text: plain-language string; MUST NOT contain secrets.
 */
async function showMessage({ kind, text }) {
  try {
    await _post("/api/state", { message: { kind, text } });
  } catch (err) {
    console.warn("[display-client] showMessage failed:", err.message);
  }
}

/**
 * Push non-secret identity fields to the display server.
 * @param {{ location_id, room_id, station_id, device_id }} identity
 */
async function showIdentity(identity) {
  try {
    await _post("/api/state", { identity });
  } catch (err) {
    console.warn("[display-client] showIdentity failed:", err.message);
  }
}

module.exports = { updateState, showMessage, showIdentity };
