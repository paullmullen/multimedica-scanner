const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.KIOSK_PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const displayState = {
  locationName: "Clínica Multimédica Z3",
  stationName: "Enfermería",
  status: "vacant", // vacant | in_process | closed
  patientName: "",
  inProcessStartedAt: null,
  updatedAt: new Date().toISOString(),
};

function touchState() {
  displayState.updatedAt = new Date().toISOString();
}

function sanitizeState(nextState = {}) {
  const allowedStatuses = new Set(["vacant", "in_process", "closed"]);

  const status = allowedStatuses.has(nextState.status)
    ? nextState.status
    : displayState.status;

  const patientName =
    typeof nextState.patientName === "string"
      ? nextState.patientName.trim()
      : displayState.patientName;

  const inProcessStartedAt =
    nextState.inProcessStartedAt === null ||
    typeof nextState.inProcessStartedAt === "string"
      ? nextState.inProcessStartedAt
      : displayState.inProcessStartedAt;

  const locationName =
    typeof nextState.locationName === "string" && nextState.locationName.trim()
      ? nextState.locationName.trim()
      : displayState.locationName;

  const stationName =
    typeof nextState.stationName === "string" && nextState.stationName.trim()
      ? nextState.stationName.trim()
      : displayState.stationName;

  return {
    locationName,
    stationName,
    status,
    patientName: status === "in_process" ? patientName : "",
    inProcessStartedAt: status === "in_process" ? inProcessStartedAt : null,
  };
}

function setVacant() {
  Object.assign(displayState, {
    status: "vacant",
    patientName: "",
    inProcessStartedAt: null,
  });
  touchState();
}

function setClosed() {
  Object.assign(displayState, {
    status: "closed",
    patientName: "",
    inProcessStartedAt: null,
  });
  touchState();
}

function setInProcess(patientName = "", inProcessStartedAt = null) {
  Object.assign(displayState, {
    status: "in_process",
    patientName: (patientName || "").trim(),
    inProcessStartedAt: inProcessStartedAt || new Date().toISOString(),
  });
  touchState();
}

app.get("/api/status", (req, res) => {
  res.json(displayState);
});

app.get("/api/status/health", (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    updatedAt: displayState.updatedAt,
    status: displayState.status,
  });
});

app.post("/api/status", (req, res) => {
  const next = sanitizeState(req.body || {});
  Object.assign(displayState, next);
  touchState();
  res.json({ ok: true, state: displayState });
});

app.post("/api/status/vacant", (req, res) => {
  setVacant();
  res.json({ ok: true, state: displayState });
});

app.post("/api/status/closed", (req, res) => {
  setClosed();
  res.json({ ok: true, state: displayState });
});

app.post("/api/status/in-process", (req, res) => {
  const body = req.body || {};
  setInProcess(body.patientName || "", body.inProcessStartedAt || null);
  res.json({ ok: true, state: displayState });
});

// Keep your demo endpoints if you want
app.post("/api/demo/vacant", (req, res) => {
  setVacant();
  res.json({ ok: true, state: displayState });
});

app.post("/api/demo/closed", (req, res) => {
  setClosed();
  res.json({ ok: true, state: displayState });
});

app.post("/api/demo/in-process", (req, res) => {
  setInProcess("María López García");
  res.json({ ok: true, state: displayState });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kiosk display server listening on port ${PORT}`);
});