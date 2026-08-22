"use strict";

/**
 * Bootstrap Controller — Multimedica Scanner
 *
 * The controller is the single owner of all barcode-scanner input during
 * bootstrap and commissioning.  It handles provisioning QRs (MMCFG: prefix)
 * and drives the commissioning-state machine.
 *
 * In Milestone 2 the controller does NOT handle production patient scans —
 * those are routed by the production service (Milestone 4).
 *
 * SECURITY RULES:
 *   - Secret values (admin_token, shared_secret, wifi_password) are NEVER
 *     logged, printed, included in error messages, or passed to the display.
 *   - All storage writes go through the Milestone 1 storage modules.
 *   - Invalid data is rejected without touching the authoritative files.
 *   - The display receives only field names and sanitised messages.
 *
 * The factory function createController() accepts optional dependency
 * overrides for testing without real hardware or network.
 */

const http = require("http");
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");

const { isConfigQr, handleConfigQr } = require("./lib/qr-contract");
const commissioning = require("./lib/commissioning");
const health = require("./lib/health");

const CONTROLLER_PORT_DEFAULT = 3000;
const PRODUCTION_SCAN_URL = "http://127.0.0.1:3002/api/scan";
const PRODUCTION_TIMEOUT_MS = 10_000;
const BOOTSTRAP_INSTALLING_MARKER = "/run/multimedica-scanner/bootstrap-installing";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a controller instance.
 *
 * @param {object} [deps]
 * @param {object} [deps.configStore]   - defaults to bootstrap/lib/config-store
 * @param {object} [deps.secretsStore]  - defaults to bootstrap/lib/secrets-store
 * @param {object} [deps.displayClient] - defaults to bootstrap/lib/display-client
 * @param {function|null} [deps.applyWifi] - async({ ssid, password, security })
 *                                          defaults to wifi-manager on Linux,
 *                                          no-op elsewhere
 */
function createController(deps) {
  const _configStore = (deps && deps.configStore) || require("./lib/config-store");
  const _secretsStore = (deps && deps.secretsStore) || require("./lib/secrets-store");
  const _displayClient = (deps && deps.displayClient) || require("./lib/display-client");
  const _applyWifi = deps && deps.applyWifi !== undefined ? deps.applyWifi : _defaultApplyWifi;
  const _productionScanUrl = (deps && deps.productionScanUrl) || PRODUCTION_SCAN_URL;
  const _productionTimeoutMs = (deps && deps.productionTimeoutMs) || PRODUCTION_TIMEOUT_MS;
  const _forwardProductionScan =
    (deps && deps.forwardProductionScan) ||
    ((scan) => postProductionScan(scan, _productionScanUrl, _productionTimeoutMs));
  let runtimeState = null;
  let transientTimer = null;
  let transientPriority = null;

  // ---- admin token (opaque; never logged) ----
  let _adminToken = null;

  function loadAdminToken() {
    _adminToken = _secretsStore.getAdminToken();
    health.setField("qr_admin_token_loaded", _adminToken !== null);
    return _adminToken !== null;
  }

  // ---- safe display helpers ----

  async function _showMsg(kind, text) {
    try {
      await _displayClient.showMessage({ kind, text });
    } catch {
      /* non-fatal */
    }
  }

  async function _applyRuntimeState(next) {
    const safe = _sanitizeRuntimeEnvelope(next);
    if (!safe) return false;
    const priority = safe.priority;
    const order = { commissioning: 4, feedback: 3, network: 2, closed: 1, room: 1 };

    if (safe.kind === "room") {
      runtimeState = safe;
      if (!transientPriority) await _displayClient.showRuntimeState(safe);
      return true;
    }

    if (transientPriority && (order[priority] || 0) < (order[transientPriority] || 0)) return false;

    transientPriority = priority;
    await _displayClient.showRuntimeState(safe);
    if (transientTimer) clearTimeout(transientTimer);
    if (safe.expires_in_ms) {
      transientTimer = setTimeout(() => {
        transientTimer = null;
        transientPriority = null;
        if (runtimeState) _displayClient.showRuntimeState(runtimeState).catch(() => {});
      }, safe.expires_in_ms);
      if (transientTimer && typeof transientTimer.unref === "function") transientTimer.unref();
    }
    return true;
  }

  async function _pushState() {
    try {
      const cfg = _configStore.readConfig();
      const sec = _secretsStore.readSecrets();
      const state = commissioning.computeState(cfg, sec);
      await _displayClient.updateState(state);
      return state;
    } catch {
      /* non-fatal */
    }
  }

  // ---- QR handlers ----

  async function _handleShowIdentity() {
    const cfg = _configStore.readConfig() || {};
    // Only non-secret identity fields; secrets are never sent to display
    await _displayClient.showIdentity({
      location_id: cfg.location_id || null,
      room_id: cfg.room_id || null,
      station_id: cfg.station_id || null,
      device_id: cfg.device_id || null,
    });
  }

  async function _handleWifiConfig(result) {
    await _showMsg("applying", `Aplicando Wi\u2011Fi: ${result.runtime.ssid}`);

    // Apply and verify first. A failed activation must not make commissioning
    // appear complete or replace the last known-good stored credentials.
    if (_applyWifi) {
      await _applyWifi(result.runtime);
    }

    // Persist only after the root helper has verified the active connection.
    _configStore.writeConfig({
      wifi_ssid: result.runtime.ssid,
      wifi_security: result.runtime.security,
    });

    // Persist password to secrets only - never logged or displayed.
    _secretsStore.writeSecrets({ wifi_password: result.runtime.password });

    await _showMsg("success", `Wi\u2011Fi aceptado: ${result.runtime.ssid}`);
    await _pushState();
  }

  async function _handleStationConfig(result) {
    _configStore.writeConfig({
      location_id: result.applied.LOCATION_ID,
      room_id: result.applied.ROOM_ID,
      station_id: result.applied.STATION_ID,
      device_id: result.applied.DEVICE_ID,
    });

    await _showMsg("success", `Estación aceptada: ${result.applied.STATION_ID}`);
    await _pushState();
  }

  async function _handleCloudConfig(result) {
    // Non-secret URL to config
    _configStore.writeConfig({ endpoint_url: result.runtime.ENDPOINT_URL });

    // Secret to secrets store only
    _secretsStore.writeSecrets({ shared_secret: result.runtime.SHARED_SECRET });

    await _showMsg("success", "Configuración de nube aceptada");
    await _pushState();
  }

  async function _handlePatientScan(rawScan) {
    const cfg = _configStore.readConfig() || {};
    const scan = {
      event_id: crypto.randomUUID(),
      visit_id: String(rawScan).replace(/^VISIT:/, ""),
      raw_scan_value: String(rawScan),
      location_id: cfg.location_id || null,
      room_id: cfg.room_id || "",
      station_id: cfg.station_id || "",
      device_id: cfg.device_id || "",
      event_type: "scan_received",
      source_type: "PI_SCANNER",
      device_timestamp_utc: new Date().toISOString(),
    };

    let response;
    try {
      response = await _forwardProductionScan(scan);
    } catch {
      await _showProductionUnavailableFeedback();
      return;
    }

    if (
      !response ||
      !["accepted", "rejected", "duplicate", "unavailable"].includes(response.disposition)
    ) {
      await _showProductionUnavailableFeedback();
      return;
    }

    if (response.runtime_state) await _applyRuntimeState(response.runtime_state);
    if (response.disposition === "unavailable") {
      await _showProductionUnavailableFeedback();
    } else if (response.disposition === "duplicate") {
      await _applyRuntimeState({
        kind: "overlay",
        state_id: `scan-duplicate-${Date.now()}`,
        priority: "feedback",
        expires_in_ms: 5_000,
        overlay: { severity: "info", title: "Lectura duplicada", detail: "Este código ya fue recibido." },
      });
    } else if (response.disposition === "rejected") {
      await _applyRuntimeState({
        kind: "overlay",
        state_id: `scan-rejected-${Date.now()}`,
        priority: "feedback",
        expires_in_ms: 5_000,
        overlay: {
          severity: "error",
          title: "Lectura rechazada",
          detail: "Verifique la visita y vuelva a escanear.",
        },
      });
    }
  }

  async function _showProductionUnavailableFeedback() {
    await _applyRuntimeState({
      kind: "overlay",
      state_id: `production-unavailable-${Date.now()}`,
      priority: "feedback",
      expires_in_ms: 10_000,
      overlay: { severity: "error", title: "Servicio no disponible", detail: "Vuelva a escanear." },
    });
  }

  // ---- main scan handler ----

  /**
   * Handle one raw scan string received from the scanner reader.
   * This function is the single entry point for all scanner input.
   */
  async function handleScan(rawScan) {
    if (!isConfigQr(rawScan)) {
      await _handlePatientScan(rawScan);
      return;
    }

    if (!_adminToken) {
      console.error("[controller] QR received but admin token not loaded");
      await _showMsg("error", "Error de configuración: no se instaló el token de arranque");
      return;
    }

    const result = handleConfigQr(rawScan, _adminToken);

    if (!result.ok) {
      // result.error never contains secret values (guaranteed by qr-contract.js)
      const safeErr = result.error || "QR validation failed";
      console.error("[controller] QR rejected:", safeErr);
      await _showMsg("error", "QR rechazado. Verifique el código e inténtelo de nuevo.");
      return;
    }

    console.log("[controller] QR accepted, kind:", result.kind);

    const HANDLERS = {
      show_identity: () => _handleShowIdentity(),
      wifi_config: () => _handleWifiConfig(result),
      station_config: () => _handleStationConfig(result),
      cloud_config: () => _handleCloudConfig(result),
    };

    const handler = HANDLERS[result.kind];
    if (!handler) {
      console.error("[controller] no handler for kind:", result.kind);
      return;
    }

    try {
      await handler();
    } catch (err) {
      // Sanitise error text — never include raw values from storage writes
      const safeMsg = _sanitiseError(err);
      console.error("[controller] apply error:", safeMsg);
      await _showMsg("error", "No se pudo actualizar la configuración.");
    }
  }

  // ---- HTTP status server ----

  function startStatusServer() {
    const port = Number(process.env.CONTROLLER_PORT || CONTROLLER_PORT_DEFAULT);
    const app = express();
    app.use(express.json({ limit: "64kb" }));

    app.post("/api/runtime-state", async (req, res) => {
      const applied = await _applyRuntimeState(req.body);
      res.status(applied ? 200 : 400).json({ ok: applied });
    });

    app.get("/api/status", (req, res) => {
      const cfg = _configStore.readConfig();
      const sec = _secretsStore.readSecrets();
      const state = commissioning.computeState(cfg, sec);
      const scannerHealth = { ...health.getSnapshot() };
      // scanner_connected was an ambiguous legacy field: it could be false
      // even when the USB device and evtest reader were both healthy. Publish
      // the two component facts plus one precisely defined readiness signal.
      delete scannerHealth.scanner_connected;
      scannerHealth.scanner_input_ready =
        scannerHealth.scanner_device_detected === true &&
        scannerHealth.scanner_reader_active === true;

      res.json({
        ok: true,
        service: "multimedica-controller",
        commissioning_state: state.state,
        configuration_complete: state.configuration_complete,
        commissioning_complete: state.commissioning_complete,
        release_installed: state.release_installed,
        production_ready: state.production_ready,
        missing_fields: state.missing,
        // Only non-secret config fields are exposed
        config: {
          location_id: cfg?.location_id || null,
          room_id: cfg?.room_id || null,
          station_id: cfg?.station_id || null,
          device_id: cfg?.device_id || null,
          endpoint_url: cfg?.endpoint_url || null,
          wifi_ssid: cfg?.wifi_ssid || null,
        },
        health: scannerHealth,
      });
    });

    const server = http.createServer(app);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[controller] status server on 127.0.0.1:${port}`);
    });
    return server;
  }

  // ---- public interface ----

  return {
    loadAdminToken,
    handleScan,
    startStatusServer,
    // Exposed for tests — allow reading current state without HTTP
    getCommissioningState: () => {
      const cfg = _configStore.readConfig();
      const sec = _secretsStore.readSecrets();
      return commissioning.computeState(cfg, sec);
    },
  };
}

function _boundedString(value, max = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function _sanitizeRuntimeEnvelope(value) {
  if (!value || typeof value !== "object") return null;
  const stateId = _boundedString(value.state_id, 128);
  if (!stateId) return null;
  if (value.kind === "room") {
    const display = value.display;
    if (
      !display ||
      typeof display !== "object" ||
      !["room_status", "closed"].includes(display.mode)
    )
      return null;
    const status = display.status;
    const allowed = [
      "available",
      "vacant",
      "patient_waiting",
      "in_process",
      "unavailable",
      "closed",
    ];
    if (!status || !allowed.includes(status.code)) return null;
    const priority = display.mode === "closed" ? "closed" : "room";
    return {
      kind: "room",
      state_id: stateId,
      priority,
      display: {
        mode: display.mode,
        room:
          display.room && typeof display.room === "object"
            ? { id: _boundedString(display.room.id), label: _boundedString(display.room.label) }
            : null,
        station:
          display.station && typeof display.station === "object"
            ? {
                id: _boundedString(display.station.id),
                label: _boundedString(display.station.label),
              }
            : null,
        status: { code: status.code, label: _boundedString(status.label) || status.code },
        patient:
          display.patient && typeof display.patient === "object"
            ? { name: _boundedString(display.patient.name) }
            : null,
        timing:
          display.timing && typeof display.timing === "object"
            ? { started_at: _boundedString(display.timing.started_at) }
            : null,
        updated_at: typeof display.updated_at === "number" ? display.updated_at : Date.now(),
      },
    };
  }
  if (value.kind === "overlay") {
    if (
      !["feedback", "network"].includes(value.priority) ||
      !Number.isInteger(value.expires_in_ms) ||
      value.expires_in_ms < 1000 ||
      value.expires_in_ms > 60000
    )
      return null;
    const overlay = value.overlay;
    if (!overlay || !["success", "info", "warning", "error"].includes(overlay.severity))
      return null;
    const title = _boundedString(overlay.title);
    const detail = _boundedString(overlay.detail);
    if (!title || !detail) return null;
    return {
      kind: "overlay",
      state_id: stateId,
      priority: value.priority,
      expires_in_ms: value.expires_in_ms,
      overlay: { severity: overlay.severity, title, detail },
    };
  }
  return null;
}

function postProductionScan(
  scan,
  urlString = PRODUCTION_SCAN_URL,
  timeoutMs = PRODUCTION_TIMEOUT_MS
) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(scan);
    const target = new URL(urlString);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk.toString();
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(null);
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("production timeout")));
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _defaultApplyWifi(runtime) {
  if (process.platform !== "linux") return Promise.resolve();
  const wifiManager = require("./lib/wifi-manager");
  return wifiManager.applyWifiConfig(runtime);
}

/** Strip any accidentally captured values from storage-layer error messages. */
function _sanitiseError(err) {
  const msg = err && err.message ? err.message : "Configuration update failed";
  // Validation errors from Milestone 1 stores include only field paths and
  // AJV keywords — no values.  This is a belt-and-suspenders truncation.
  if (msg.length > 200) return msg.slice(0, 200) + "\u2026";
  return msg;
}

// ---------------------------------------------------------------------------
// Production entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log("[controller] starting");
  const ctrl = createController();
  const tokenOk = ctrl.loadAdminToken();
  if (!tokenOk) {
    console.warn(
      "[controller] admin token not loaded; QR validation will fail until secrets.json is populated"
    );
  }

  const server = ctrl.startStatusServer();

  // Push initial commissioning state to display
  try {
    const _displayClient = require("./lib/display-client");
    const cfg = require("./lib/config-store").readConfig();
    const sec = require("./lib/secrets-store").readSecrets();
    const state = commissioning.computeState(cfg, sec);
    await _displayClient.updateState(state);
  } catch (err) {
    console.error("[controller] initial display update failed:", err.message);
  }

  // Start scanner reader on Linux
  if (process.platform === "linux") {
    const scannerReader = require("./lib/scanner-reader");
    const _displayClient = require("./lib/display-client");
    scannerReader
      .start(ctrl.handleScan, (status) => {
        health.setField("scanner_device_detected", status.device_detected === true);
        health.setField("scanner_reader_active", status.reader_active === true);
        if (status.reader_active) {
          const bootstrapInstalling = fs.existsSync(BOOTSTRAP_INSTALLING_MARKER);
          _displayClient
            .showMessage(
              bootstrapInstalling
                ? {
                    kind: "installing",
                    text: "Espere. No escanee códigos todavía.",
                  }
                : {
                    kind: "info",
                    text: "Escáner listo. Escanee el QR de configuración de Wi-Fi.",
                  }
            )
            .catch(() => {});
        } else {
          _displayClient
            .showMessage({ kind: "error", text: "Escáner no disponible. Revise la conexión USB." })
            .catch(() => {});
        }
      })
      .catch((err) => {
        console.error("[controller] scanner reader fatal:", err.message);
        health.setField("scanner_reader_active", false);
      });
  } else {
    console.log("[controller] scanner reader not started (non-Linux)");
  }

  return { server, ctrl };
}

module.exports = { createController };

if (require.main === module) {
  main().catch((err) => {
    console.error("[controller] fatal:", err.message);
    process.exit(1);
  });
}
