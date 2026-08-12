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

const { isConfigQr, handleConfigQr } = require("./lib/qr-contract");
const commissioning = require("./lib/commissioning");
const health = require("./lib/health");

const CONTROLLER_PORT_DEFAULT = 3000;

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
    await _showMsg("applying", `Applying Wi\u2011Fi: ${result.runtime.ssid}`);

    // 1. Persist non-secret fields to config
    _configStore.writeConfig({
      wifi_ssid: result.runtime.ssid,
      wifi_security: result.runtime.security,
    });

    // 2. Persist password to secrets only — never logged or displayed
    _secretsStore.writeSecrets({ wifi_password: result.runtime.password });

    // 3. Apply on Linux (or via injected function)
    if (_applyWifi) {
      await _applyWifi(result.runtime);
    }

    await _showMsg("success", `Wi\u2011Fi accepted: ${result.runtime.ssid}`);
    await _pushState();
  }

  async function _handleStationConfig(result) {
    _configStore.writeConfig({
      location_id: result.applied.LOCATION_ID,
      room_id: result.applied.ROOM_ID,
      station_id: result.applied.STATION_ID,
      device_id: result.applied.DEVICE_ID,
    });

    await _showMsg("success", `Station accepted: ${result.applied.STATION_ID}`);
    await _pushState();
  }

  async function _handleCloudConfig(result) {
    // Non-secret URL to config
    _configStore.writeConfig({ endpoint_url: result.runtime.ENDPOINT_URL });

    // Secret to secrets store only
    _secretsStore.writeSecrets({ shared_secret: result.runtime.SHARED_SECRET });

    await _showMsg("success", "Cloud configuration accepted");
    await _pushState();
  }

  // ---- main scan handler ----

  /**
   * Handle one raw scan string received from the scanner reader.
   * This function is the single entry point for all scanner input.
   */
  async function handleScan(rawScan) {
    if (!isConfigQr(rawScan)) {
      // Ordinary patient scan — bootstrap mode does not route these
      console.log("[controller] non-config scan ignored in bootstrap mode");
      return;
    }

    if (!_adminToken) {
      console.error("[controller] QR received but admin token not loaded");
      await _showMsg("error", "Configuration error: bootstrap token not installed");
      return;
    }

    const result = handleConfigQr(rawScan, _adminToken);

    if (!result.ok) {
      // result.error never contains secret values (guaranteed by qr-contract.js)
      const safeErr = result.error || "QR validation failed";
      console.error("[controller] QR rejected:", safeErr);
      await _showMsg("error", `QR rejected: ${safeErr}`);
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
      await _showMsg("error", safeMsg);
    }
  }

  // ---- HTTP status server ----

  function startStatusServer() {
    const port = Number(process.env.CONTROLLER_PORT || CONTROLLER_PORT_DEFAULT);
    const app = express();
    app.use(express.json({ limit: "64kb" }));

    app.get("/api/status", (req, res) => {
      const cfg = _configStore.readConfig();
      const sec = _secretsStore.readSecrets();
      const state = commissioning.computeState(cfg, sec);
      const snap = health.getSnapshot();

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
        health: snap,
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
    await scannerReader.start(ctrl.handleScan);
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
