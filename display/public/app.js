const appEl = document.getElementById("app");
const statusTextEl = document.getElementById("statusText");
const patientNameEl = document.getElementById("patientName");
const roomValueEl = document.getElementById("roomValue");
const stationValueEl = document.getElementById("stationValue");
const stationBadgeEl = document.getElementById("stationBadge");
const elapsedValueEl = document.getElementById("elapsedValue");
const updatedValueEl = document.getElementById("updatedValue");
const dateTimeValueEl = document.getElementById("dateTimeValue");

let startedAtMs = null;
let lastStatus = null;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return "00:00";

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${pad2(minutes)}:${pad2(seconds)}`;
}

function formatShortTime(dateValue) {
  if (!dateValue) return "--:--";

  const date = new Date(dateValue);
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatFooterDateTime(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();

  return date.toLocaleString([], {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDisplayStatus(status) {
  switch (status) {
    case "in_process":
      return "EN PROCESO";
    case "closed":
      return "NO DISPONIBLE";
    case "vacant":
    default:
      return "VACANTE";
  }
}

function applyStateClass(status) {
  appEl.classList.remove("state-vacant", "state-in-process", "state-unavailable");

  switch (status) {
    case "in_process":
      appEl.classList.add("state-in-process");
      break;
    case "closed":
      appEl.classList.add("state-unavailable");
      break;
    case "vacant":
    default:
      appEl.classList.add("state-vacant");
      break;
  }
}

function setDisplay(data) {
  const status = data.status || "vacant";
  lastStatus = status;

  applyStateClass(status);

  statusTextEl.textContent = toDisplayStatus(status);
  patientNameEl.textContent = data.patientName || "—";

  const roomName = data.locationName || "—";
  const stationName = data.stationName || "—";

  roomValueEl.textContent = roomName;
  stationValueEl.textContent = stationName;
  stationBadgeEl.textContent = String(stationName).slice(0, 3).toUpperCase();

  if (data.inProcessStartedAt) {
    startedAtMs = new Date(data.inProcessStartedAt).getTime();
  } else if (status !== "in_process") {
    startedAtMs = null;
  }

  updatedValueEl.textContent = formatShortTime(data.updatedAt || Date.now());
  dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

function refreshElapsed() {
  if (lastStatus === "in_process" && startedAtMs) {
    elapsedValueEl.textContent = formatElapsed(Date.now() - startedAtMs);
  } else {
    elapsedValueEl.textContent = "00:00";
  }
}

function refreshClock() {
  dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

async function fetchStatus() {
  try {
    const response = await fetch("/api/status");

    if (!response.ok) {
      throw new Error(`Status API returned ${response.status}`);
    }

    const data = await response.json();
    setDisplay(data);
  } catch (error) {
    console.error("Failed to fetch scanner status:", error);

    setDisplay({
      status: "closed",
      patientName: "—",
      locationName: "—",
      stationName: "—",
      updatedAt: Date.now(),
    });
  }
}

refreshClock();
refreshElapsed();

setInterval(refreshClock, 1000);
setInterval(refreshElapsed, 1000);

fetchStatus();
setInterval(fetchStatus, 2000);