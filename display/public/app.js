window.addEventListener("error", (event) => {
  console.error(
    "WINDOW ERROR:",
    event.message,
    event.filename,
    event.lineno,
    event.colno,
    event.error
  );
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("UNHANDLED PROMISE REJECTION:", event.reason);
});

console.log("APP STARTED");

const appEl = document.getElementById("app");
const statusTextEl = document.getElementById("statusText");
const patientNameEl = document.getElementById("patientName");
const roomValueEl = document.getElementById("roomValue");
const stationValueEl = document.getElementById("stationValue");
const stationBadgeEl = document.getElementById("stationBadge");
const elapsedValueEl = document.getElementById("elapsedValue");
const updatedValueEl = document.getElementById("updatedValue");
const dateTimeValueEl = document.getElementById("dateTimeValue");

console.log("DOM CHECK", {
  appEl: !!appEl,
  statusTextEl: !!statusTextEl,
  patientNameEl: !!patientNameEl,
  roomValueEl: !!roomValueEl,
  stationValueEl: !!stationValueEl,
  stationBadgeEl: !!stationBadgeEl,
  elapsedValueEl: !!elapsedValueEl,
  updatedValueEl: !!updatedValueEl,
  dateTimeValueEl: !!dateTimeValueEl,
});

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
      return "EN\nPROCESO";
    case "closed":
      return "NO\nDISPONIBLE";
    case "vacant":
    default:
      return "VACIO";
  }
}

function applyStateClass(status) {
  if (!appEl) {
    console.error("appEl is missing from index.html");
    return;
  }

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

  if (statusTextEl) {
    statusTextEl.textContent = toDisplayStatus(status);
  } else {
    console.error("statusTextEl is missing from index.html");
  }

  if (patientNameEl) {
    patientNameEl.textContent = data.patientName || "—";
  } else {
    console.error("patientNameEl is missing from index.html");
  }

  const roomName = data.locationName || "—";
  const stationName = data.stationName || "—";

  if (roomValueEl) {
    roomValueEl.textContent = roomName;
  } else {
    console.error("roomValueEl is missing from index.html");
  }

  if (stationValueEl) {
    stationValueEl.textContent = stationName;
  } else {
    console.error("stationValueEl is missing from index.html");
  }

  if (stationBadgeEl) {
    stationBadgeEl.textContent = String(stationName).slice(0, 3).toUpperCase();
  } else {
    console.error("stationBadgeEl is missing from index.html");
  }

  if (data.inProcessStartedAt) {
    startedAtMs = new Date(data.inProcessStartedAt).getTime();
  } else if (status !== "in_process") {
    startedAtMs = null;
  }

  if (updatedValueEl) {
    updatedValueEl.textContent = formatShortTime(data.updatedAt || Date.now());
  } else {
    console.error("updatedValueEl is missing from index.html");
  }

  if (dateTimeValueEl) {
    dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
  } else {
    console.error("dateTimeValueEl is missing from index.html");
  }
}

function refreshElapsed() {
  if (!elapsedValueEl) {
    console.error("elapsedValueEl is missing from index.html");
    return;
  }

  if (lastStatus === "in_process" && startedAtMs) {
    elapsedValueEl.textContent = formatElapsed(Date.now() - startedAtMs);
  } else {
    elapsedValueEl.textContent = "00:00";
  }
}

function refreshClock() {
  if (!dateTimeValueEl) {
    console.error("dateTimeValueEl is missing from index.html");
    return;
  }

  dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

async function fetchStatus() {
  try {
    console.log("Fetching /api/status...");
    const response = await fetch("/api/status");

    if (!response.ok) {
      throw new Error(`Status API returned ${response.status}`);
    }

    const data = await response.json();
    console.log("Status response:", data);
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