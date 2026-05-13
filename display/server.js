const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const app = express();

const PORT = Number(process.env.KIOSK_PORT || 3001);
const STATE_FILE = path.join(__dirname, "state.json");


const DISPLAY_SERVER_CONFIG = Object.freeze({
  trust: Object.freeze({
    staleMs: Number(process.env.DISPLAY_STALE_MS || 90_000),
    veryStaleMs: Number(process.env.DISPLAY_VERY_STALE_MS || 180_000),
  }),

  network: Object.freeze({
    wifiCheckTimeoutMs: 1_500,
  }),

  bodyParser: Object.freeze({
    jsonLimit: "1mb",
  }),

  server: Object.freeze({
    host: "0.0.0.0",
  }),
});

const TRUST_CONFIG = DISPLAY_SERVER_CONFIG.trust;

app.use(express.json({ limit: DISPLAY_SERVER_CONFIG.bodyParser.jsonLimit }));
app.use(express.static(path.join(__dirname, "public")));

function nowIso() {
  return new Date().toISOString();
}

function getInitialDisplayState() {
  return {
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

    meta: {
      source: "local_only",
      trust: "unknown",
      status_message: "Inicializando",
      last_cloud_update: null,
      last_local_update: nowIso(),
      cache_loaded_at: null,
      cache_age_ms: null,
      wifi_connected: null,
    },

    updated_at: nowIso(),
  };
}

let displayState = getInitialDisplayState();

function safeReadStateFile() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error("[kiosk-display] Could not read state file:", err.message);
    return null;
  }
}

function safeWriteStateFile(state) {
  try {
    const tmpFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    console.error("[kiosk-display] Could not write state file:", err.message);
  }
}

function getWifiStatus() {
  return new Promise((resolve) => {
    execFile("nmcli", ["-t", "-f", "STATE", "general"], { timeout: DISPLAY_SERVER_CONFIG.network.wifiCheckTimeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }

      const state = String(stdout || "")
        .trim()
        .toLowerCase();
      resolve(state === "connected");
    });
  });
}

function getAgeMs(isoDate) {
  if (!isoDate) return null;
  const parsed = new Date(isoDate).getTime();
  if (Number.isNaN(parsed)) return null;
  return Date.now() - parsed;
}

function normalizeDisplayState(incoming = {}) {
  const safeIncoming = incoming && typeof incoming === "object" ? incoming : {};
  const sourceCandidate = safeIncoming.display || safeIncoming.state || safeIncoming;
  const source = sourceCandidate && typeof sourceCandidate === "object" ? sourceCandidate : {};

  return {
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

    meta: {
      ...(displayState?.meta || {}),
      ...(source.meta || {}),
    },
  };
}

function mergeHealthStatus(baseHealth = {}, statusHealth = {}) {
  return {
    ...baseHealth,
    ...statusHealth,

    scanner_connected: baseHealth.scanner_connected,
    scanner_status: baseHealth.scanner_status,
    scanner_message: baseHealth.scanner_message,
    scanner_error_message: baseHealth.scanner_error_message,
    last_scanner_error_at: baseHealth.last_scanner_error_at,
    last_scanner_connected_at: baseHealth.last_scanner_connected_at,
  };
}

function evaluateTrustState(state, wifiConnected) {
  const next = {
    ...getInitialDisplayState(),
    ...state,
    room: {
      ...getInitialDisplayState().room,
      ...(state.room || {}),
    },
    station: {
      ...getInitialDisplayState().station,
      ...(state.station || {}),
    },
    status: {
      ...getInitialDisplayState().status,
      ...(state.status || {}),
    },
    timing: {
      ...getInitialDisplayState().timing,
      ...(state.timing || {}),
    },
    health: {
      ...getInitialDisplayState().health,
      ...(state.health || {}),
    },
    meta: {
      ...getInitialDisplayState().meta,
      ...(state.meta || {}),
    },
  };

  const lastCloudUpdate = next.meta.last_cloud_update || next.updated_at || null;
  const cacheAgeMs = getAgeMs(lastCloudUpdate);

  next.meta.wifi_connected = wifiConnected;
  next.meta.cache_age_ms = cacheAgeMs;
  next.meta.last_local_update = nowIso();

  if (next.operational_mode === "closed" || next.status?.code === "closed") {
    next.meta.source = next.meta.last_cloud_update ? "cloud" : "local_only";
    next.meta.trust = "fresh";
    next.meta.status_message = "Clínica cerrada";

    next.health = mergeHealthStatus(next.health, {
      code: "ok",
      label: "Clínica cerrada",
      updated_at: nowIso(),
    });
  } else if (wifiConnected === false) {
    next.meta.source = next.meta.last_cloud_update ? "cached_cloud" : "local_only";
    next.meta.trust = "offline";
    next.meta.status_message = "Sin conexión WiFi";

    next.health = mergeHealthStatus(next.health, {
      code: "warning",
      label: "Sin conexión WiFi",
      updated_at: nowIso(),
    });
  } else if (cacheAgeMs !== null && cacheAgeMs > TRUST_CONFIG.veryStaleMs) {
    next.meta.source = "cached_cloud";
    next.meta.trust = "offline";
    next.meta.status_message = "Sin conexión con la nube";

    next.health = mergeHealthStatus(next.health, {
      code: "warning",
      label: "Sin conexión con la nube",
      updated_at: nowIso(),
    });
  } else if (cacheAgeMs !== null && cacheAgeMs > TRUST_CONFIG.staleMs) {
    next.meta.source = "cached_cloud";
    next.meta.trust = "stale";
    next.meta.status_message = "Usando datos guardados";

    next.health = mergeHealthStatus(next.health, {
      code: "warning",
      label: "Usando datos guardados",
      updated_at: nowIso(),
    });
  } else if (next.meta.last_cloud_update) {
    next.meta.source = "cloud";
    next.meta.trust = "fresh";
    next.meta.status_message = "Sincronizado";

    next.health = mergeHealthStatus(next.health, {
      code: "ok",
      label: "Conectado",
      updated_at: nowIso(),
    });
  } else {
    next.meta.source = "local_only";
    next.meta.trust = "unknown";
    next.meta.status_message = "Esperando sincronización";

    next.health = mergeHealthStatus(next.health, {
      code: "warning",
      label: "Esperando sincronización",
      updated_at: nowIso(),
    });
  }

  return next;
}

const cachedState = safeReadStateFile();

if (cachedState) {
  displayState = {
    ...normalizeDisplayState(cachedState),
    meta: {
      ...(cachedState.meta || {}),
      source: "cached_cloud",
      trust: "unknown",
      status_message: "Cargando datos guardados",
      cache_loaded_at: nowIso(),
      last_local_update: nowIso(),
    },
  };

  console.log("[kiosk-display] Loaded cached display state.");
} else {
  console.log("[kiosk-display] No cached display state found. Using defaults.");
}

app.get("/api/display", async (req, res) => {
  const wifiConnected = await getWifiStatus();
  displayState = evaluateTrustState(displayState, wifiConnected);
  res.json(displayState);
});

app.post("/api/display", async (req, res) => {
  const receivedAt = nowIso();

  const next = normalizeDisplayState(req.body);

  next.meta = {
    ...(next.meta || {}),
    source: "cloud",
    trust: "fresh",
    status_message: "Sincronizado",
    last_cloud_update: next.updated_at || receivedAt,
    last_local_update: receivedAt,
  };

  app.post("/api/health", async (req, res) => {
    const receivedAt = nowIso();
    const patch = req.body?.health && typeof req.body.health === "object" ? req.body.health : {};

    displayState = {
      ...displayState,
      health: {
        ...(displayState.health || {}),
        ...patch,
        updated_at: receivedAt,
      },
      meta: {
        ...(displayState.meta || {}),
        last_local_update: receivedAt,
      },
    };

    const wifiConnected = await getWifiStatus();
    displayState = evaluateTrustState(displayState, wifiConnected);

    safeWriteStateFile(displayState);

    res.json({ ok: true, health: displayState.health });
  });

  const wifiConnected = await getWifiStatus();
  displayState = evaluateTrustState(next, wifiConnected);

  safeWriteStateFile(displayState);

  res.json({ ok: true, display: displayState });
});

app.get("/status", async (req, res) => {
  const wifiConnected = await getWifiStatus();
  displayState = evaluateTrustState(displayState, wifiConnected);

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
    meta: displayState.meta,
    state_file_exists: fs.existsSync(STATE_FILE),
  });
});

app.get("/status/summary", async (req, res) => {
  const wifiConnected = await getWifiStatus();
  displayState = evaluateTrustState(displayState, wifiConnected);

  res.json({
    ok: true,
    operational_mode: displayState.operational_mode,
    mode: displayState.mode,
    status: displayState.status?.code || null,
    health: displayState.health?.code || null,
    health_label: displayState.health?.label || null,
    trust: displayState.meta?.trust || null,
    source: displayState.meta?.source || null,
    status_message: displayState.meta?.status_message || null,
    wifi_connected: displayState.meta?.wifi_connected ?? null,
    updated_at: displayState.updated_at,
    last_cloud_update: displayState.meta?.last_cloud_update || null,
  });
});

app.listen(PORT, DISPLAY_SERVER_CONFIG.server.host, () => {
  console.log(`kiosk-display listening on port ${PORT}`);
  console.log(`kiosk-display state file: ${STATE_FILE}`);
});
