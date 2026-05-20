// displayRoutes.js

const express = require("express");
const {
  getState,
  setRoomStatus,
  setOverlay,
  resetState,
} = require("./displayState");

const router = express.Router();

function sendBadRequest(res, message) {
  return res.status(400).json({
    ok: false,
    error: message,
    timestamp: new Date().toISOString(),
  });
}

router.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: "scanner-display-state",
    timestamp: new Date().toISOString(),
  });
});

router.get("/display", (req, res) => {
  return res.json({
    ok: true,
    state: getState(),
  });
});

router.post("/display/room-status", (req, res) => {
  const body = req.body ?? {};

  if (!body.room || !body.station || !body.status) {
    return sendBadRequest(
      res,
      "room, station, and status objects are required"
    );
  }

  if (!body.room.room_id || !body.station.station_id || !body.status.code) {
    return sendBadRequest(
      res,
      "room.room_id, station.station_id, and status.code are required"
    );
  }

  const state = setRoomStatus(body);

  return res.json({
    ok: true,
    state,
  });
});

router.post("/display/overlay", (req, res) => {
  const body = req.body ?? {};

  if (!body.title) {
    return sendBadRequest(res, "title is required");
  }

  const state = setOverlay(body);

  return res.json({
    ok: true,
    state,
  });
});

router.post("/display/reset", (req, res) => {
  const state = resetState();

  return res.json({
    ok: true,
    state,
  });
});

module.exports = router;