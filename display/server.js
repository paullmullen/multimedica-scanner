const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.KIOSK_PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let currentDisplayState = {
  mode: "room_status",
  updated_at: Date.now(),
  room: { label: process.env.ROOM_ID || "—" },
  station: { label: process.env.STATION_ID || "—" },
  status: { code: "available", label: "DISPONIBLE" },
  patient: { name: "—" },
  timing: { started_at: null },
};

app.get("/api/display", (req, res) => {
  res.json({
    ok: true,
    state: currentDisplayState,
  });
});

app.post("/api/display", (req, res) => {
  const { display } = req.body;

  if (!display || !display.mode) {
    return res.status(400).json({
      ok: false,
      error: "Invalid display payload",
    });
  }

  currentDisplayState = {
    ...display,
    updated_at: display.updated_at || Date.now(),
  };

  console.log("DISPLAY STATE UPDATED:", currentDisplayState);

  return res.json({
    ok: true,
    state: currentDisplayState,
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Kiosk display server listening on port ${PORT}`);
});