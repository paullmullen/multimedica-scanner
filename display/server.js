const express = require("express");
const path = require("path");

const app = express();

const PORT = Number(process.env.KIOSK_PORT || 3001);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function nowIso() {
  return new Date().toISOString();
}

let displayState = {
  mode: "vacant",
  operational_mode: "open",

  room: {
    id: process.env.ROOM_ID || null,
    label: process.env.ROOM_ID || "Room",
  },

  station: {
    id: process.env.STATION_ID || null,
    label: process.env.STATION_ID || "Station",
  },

  status: {
    code: "vacant",
    label: "Disponible",
  },

  patient: null,

  timing: {
    started_at: null,
  },

  overlay: null,

  health: {
    code: "ok",
    label: "Conectado",
    updated_at: nowIso(),
  },

  updated_at: nowIso(),
};

function normalizeDisplayState(incoming = {}) {
  const safeIncoming = incoming && typeof incoming === "object" ? incoming : {};

  const sourceCandidate = safeIncoming.display || safeIncoming.state || safeIncoming;

  const source = sourceCandidate && typeof sourceCandidate === "object" ? sourceCandidate : {};

  const next = {
    mode: source.mode || displayState?.mode || "vacant",

    operational_mode: source.operational_mode || displayState?.operational_mode || "open",

    updated_at: source.updated_at || nowIso(),

    room: {
      ...(displayState?.room || {}),
      ...(source.room || {}),
    },

    station: {
      ...(displayState?.station || {}),
      ...(source.station || {}),
    },

    status: {
      ...(displayState?.status || {}),
      ...(source.status || {}),
    },

    patient: source.patient === undefined ? displayState?.patient || null : source.patient,

    timing: {
      ...(displayState?.timing || {}),
      ...(source.timing || {}),
    },

    overlay: source.overlay === undefined ? displayState?.overlay || null : source.overlay,

    health: {
      ...(displayState?.health || {}),
      ...(source.health || {}),
      updated_at: source.health?.updated_at || source.updated_at || nowIso(),
    },
  };

  return next;
}

app.get("/api/display", (req, res) => {
  res.json(displayState);
});

app.post("/api/display", (req, res) => {
  displayState = normalizeDisplayState(req.body);
  res.json({ ok: true, display: displayState });
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    service: "kiosk-display",
    port: PORT,
    room_id: process.env.ROOM_ID || null,
    station_id: process.env.STATION_ID || null,
    device_id: process.env.DEVICE_ID || null,
    display_updated_at: displayState.updated_at,
    operational_mode: displayState.operational_mode,
    mode: displayState.mode,
    health: displayState.health,
  });
});

app.get("/status/summary", (req, res) => {
  res.json({
    ok: true,
    operational_mode: displayState.operational_mode,
    mode: displayState.mode,
    status: displayState.status?.code || null,
    health: displayState.health?.code || null,
    updated_at: displayState.updated_at,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`kiosk-display listening on port ${PORT}`);
});
