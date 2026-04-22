console.log("Scanner display loaded");

const card = document.getElementById("card");
const statusEl = document.getElementById("status");
const patientNameEl = document.getElementById("patientName");
const roomValueEl = document.getElementById("roomValue");
const stationValueEl = document.getElementById("stationValue");
const stationPillEl = document.getElementById("stationPill");
const elapsedValueEl = document.getElementById("elapsedValue");
const updatedValueEl = document.getElementById("updatedValue");
const footerMessageEl = document.getElementById("footerMessage");

let stateStartedAt = null;

function formatClock(date) {
  if (!date) return "--:--";
  return new Date(date).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setCardState(state) {
  card.classList.remove(
    "state-ready",
    "state-in-process",
    "state-vacant",
    "state-error"
  );

  switch (state) {
    case "in_process":
      card.classList.add("state-in-process");
      break;
    case "vacant":
      card.classList.add("state-vacant");
      break;
    case "error":
      card.classList.add("state-error");
      break;
    case "ready":
    default:
      card.classList.add("state-ready");
      break;
  }
}

function setDisplay(data) {
  const state = data.state || "ready";
  const statusText =
    data.statusText ||
    (state === "in_process"
      ? "IN PROCESS"
      : state === "vacant"
        ? "VACANT"
        : state === "error"
          ? "ERROR"
          : "READY");

  statusEl.textContent = statusText;
  patientNameEl.textContent = data.patientName || "—";
  roomValueEl.textContent = data.roomId || "reg_room_1";
  stationValueEl.textContent = data.stationId || "reg";
  stationPillEl.textContent = (data.stationId || "reg").toUpperCase();
  updatedValueEl.textContent = formatClock(data.updatedAt || Date.now());

  if (data.message) {
    footerMessageEl.textContent = data.message;
  } else if (state === "in_process") {
    footerMessageEl.textContent = "Patient currently being processed";
  } else if (state === "vacant") {
    footerMessageEl.textContent = "Room available";
  } else if (state === "error") {
    footerMessageEl.textContent = "Display disconnected or invalid state";
  } else {
    footerMessageEl.textContent = "Waiting for scanner activity";
  }

  if (data.startedAt) {
    stateStartedAt = new Date(data.startedAt).getTime();
  } else if (state !== "in_process") {
    stateStartedAt = null;
  }

  setCardState(state);
}

function updateElapsed() {
  if (!stateStartedAt) {
    elapsedValueEl.textContent = "00:00";
    return;
  }

  elapsedValueEl.textContent = formatElapsed(Date.now() - stateStartedAt);
}

async function fetchStatus() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    setDisplay(data);
  } catch (error) {
    console.error("Failed to fetch status", error);

    setDisplay({
      state: "error",
      statusText: "OFFLINE",
      patientName: "—",
      message: "Unable to reach local status API",
      updatedAt: Date.now(),
    });
  }
}

/*
  Temporary local demo state:
  Uncomment this block if you want to preview the formatting
  before the backend /api/status endpoint is fully wired.

setDisplay({
  state: "in_process",
  patientName: "PAUL M.",
  roomId: "reg_room_1",
  stationId: "reg",
  message: "Preview mode",
  startedAt: Date.now() - 125000,
  updatedAt: Date.now(),
});
*/

updateElapsed();
setInterval(updateElapsed, 1000);

fetchStatus();
setInterval(fetchStatus, 2000);