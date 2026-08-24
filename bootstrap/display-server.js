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
  runtime: null,
  last_updated: null,
});

let _state = Object.assign({}, INITIAL_STATE);

function _safeString(v, max = 240) {
  return typeof v === "string" && v.length <= max ? v : null;
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

function _safeRuntime(v) {
  if (!v || typeof v !== "object" || !_safeString(v.state_id, 128)) return null;
  if (v.kind === "room" && v.display && typeof v.display === "object") {
    const source = v.display;
    const mode = source.mode === "closed" ? "closed" : source.mode === "room_status" ? "room_status" : null;
    if (!mode) return null;
    const statusCode = source.status && ["available", "vacant", "patient_waiting", "in_process", "unavailable", "closed"].includes(source.status.code)
      ? source.status.code : mode === "closed" ? "closed" : "available";
    return {
      kind: "room",
      state_id: v.state_id,
      display: {
        mode,
        room: _safeLabel(source.room),
        station: _safeLabel(source.station),
        status: { code: statusCode, label: _safeString(source.status && source.status.label, 100) },
        patient: source.patient && _safeString(source.patient.name, 160)
          ? { name: _safeString(source.patient.name, 160) } : null,
        timing: source.timing && _safeString(source.timing.started_at, 40)
          ? { started_at: _safeString(source.timing.started_at, 40) } : null,
        updated_at: _safeString(source.updated_at, 40),
      },
    };
  }
  if (v.kind === "overlay" && v.overlay && typeof v.overlay === "object") {
    const severity = ["success", "info", "warning", "error"].includes(v.overlay.severity)
      ? v.overlay.severity : "info";
    const title = _safeString(v.overlay.title, 100);
    const detail = _safeString(v.overlay.detail, 240);
    if (!title && !detail) return null;
    return { kind: "overlay", state_id: v.state_id, overlay: { severity, title, detail } };
  }
  if (v.kind === "identity" && v.identity && typeof v.identity === "object") {
    const identity = {
      location_id: _safeString(v.identity.location_id, 128),
      room_id: _safeString(v.identity.room_id, 128),
      station_id: _safeString(v.identity.station_id, 128),
      device_id: _safeString(v.identity.device_id, 128),
      production_version: _safeString(v.identity.production_version, 64),
      ip_address: _safeString(v.identity.ip_address, 64),
    };
    if (!Object.values(identity).some(Boolean)) return null;
    return { kind: "identity", state_id: v.state_id, identity };
  }
  return null;
}

function _safeLabel(v) {
  if (!v || typeof v !== "object") return null;
  return { id: _safeString(v.id, 128), label: _safeString(v.label, 160) };
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
  if (body.runtime !== undefined) _state.runtime = _safeRuntime(body.runtime);

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
