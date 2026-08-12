"use strict";

/**
 * Bootstrap Display Server — Multimedica Scanner
 *
 * Serves the commissioning status page and accepts state-push requests
 * from the bootstrap controller.
 *
 * PORT: DISPLAY_PORT env variable (default 3001).
 * Binds to 0.0.0.0 so the kiosk browser can connect on the local machine
 * and a technician can reach it from the same LAN.
 *
 * SECRET VALUES must never enter this server through any path.
 * The /api/state endpoint accepts only the fields defined in _SAFE_FIELDS.
 */

const express = require("express");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.DISPLAY_PORT || 3001);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const INITIAL_STATE = Object.freeze({
  commissioning_state: "starting",
  configuration_complete: false,
  commissioning_complete: false,
  release_installed: false,
  production_ready: false,
  missing_fields: [],
  message: null,
  identity: null,
  last_updated: null,
});

let _state = Object.assign({}, INITIAL_STATE);

function _safeString(v) {
  return typeof v === "string" ? v : null;
}

function _safeBool(v, fallback) {
  return typeof v === "boolean" ? v : fallback;
}

function _safeArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

function _safeMessage(v) {
  if (!v || typeof v !== "object") return null;
  return {
    kind: _safeString(v.kind) || "info",
    text: _safeString(v.text) || "",
  };
}

function _safeIdentity(v) {
  if (!v || typeof v !== "object") return null;
  // Only non-secret identity fields are ever stored/served
  return {
    location_id: _safeString(v.location_id),
    room_id: _safeString(v.room_id),
    station_id: _safeString(v.station_id),
    device_id: _safeString(v.device_id),
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

/**
 * POST /api/state
 * Controller pushes commissioning state and messages here.
 * Only safe, explicitly listed fields are accepted.
 */
app.post("/api/state", (req, res) => {
  const body = req.body || {};

  if (body.state !== undefined)
    _state.commissioning_state = _safeString(body.state) || _state.commissioning_state;
  if (body.configuration_complete !== undefined)
    _state.configuration_complete = _safeBool(
      body.configuration_complete,
      _state.configuration_complete
    );
  if (body.commissioning_complete !== undefined)
    _state.commissioning_complete = _safeBool(
      body.commissioning_complete,
      _state.commissioning_complete
    );
  if (body.release_installed !== undefined)
    _state.release_installed = _safeBool(body.release_installed, _state.release_installed);
  if (body.production_ready !== undefined)
    _state.production_ready = _safeBool(body.production_ready, _state.production_ready);
  if (body.missing !== undefined) _state.missing_fields = _safeArray(body.missing);
  if (body.message !== undefined) _state.message = _safeMessage(body.message);
  if (body.identity !== undefined) _state.identity = _safeIdentity(body.identity);

  _state.last_updated = new Date().toISOString();

  res.json({ ok: true });
});

/** GET /api/state — browser polls this */
app.get("/api/state", (req, res) => {
  res.json(_state);
});

/** GET /api/health — controller and installer poll this */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "multimedica-display",
    port: PORT,
    started_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[display] server listening on port ${PORT}`);
});

server.on("error", (err) => {
  console.error("[display] server error:", err.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Exports (for tests and controller integration)
// ---------------------------------------------------------------------------

function getState() {
  return _state;
}
function resetState() {
  _state = Object.assign({}, INITIAL_STATE);
}

module.exports = { app, server, getState, resetState };
