"use strict";

/**
 * Production scan API. The bootstrap controller owns scanner input and sends
 * ordinary scans here over loopback; this service alone talks to the cloud.
 */

const http = require("http");
const https = require("https");
const express = require("express");

const CLOUD_TIMEOUT_MS = 8_000;
const PRODUCTION_PORT_DEFAULT = 3002;

function createProductionScanServer(deps = {}) {
  const configStore = deps.configStore || require("../bootstrap/lib/config-store");
  const secretsStore = deps.secretsStore || require("../bootstrap/lib/secrets-store");
  const cloudRequest = deps.cloudRequest || postToCloud;
  const logger = deps.logger || (() => {});
  const port = Number(deps.port || process.env.PRODUCTION_PORT || PRODUCTION_PORT_DEFAULT);

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  function runtime() {
    const config = configStore.readConfig() || {};
    const secrets = secretsStore.readSecrets() || {};
    const ready = Boolean(
      config.endpoint_url &&
        secrets.shared_secret &&
        config.room_id &&
        config.station_id &&
        config.device_id,
    );
    return { config, secrets, ready };
  }

  app.get("/api/status", (_req, res) => {
    const state = runtime();
    res.json({
      ok: state.ready,
      service: "multimedica-production",
      state: state.ready ? "healthy" : "starting",
    });
  });

  app.post("/api/scan", async (req, res) => {
    const state = runtime();
    if (!state.ready) {
      return res.status(503).json(unavailable("production service not ready"));
    }

    const validationError = validateScanRequest(req.body);
    if (validationError) {
      return res.status(200).json({
        ok: false,
        disposition: "rejected",
        duplicate: false,
        reason: validationError,
      });
    }

    try {
      const cloud = await cloudRequest(state.config.endpoint_url, req.body, state.secrets.shared_secret);
      return res.status(200).json(normalizeCloudResponse(cloud));
    } catch (error) {
      logger("[production] cloud forwarding unavailable");
      return res.status(503).json(unavailable("cloud endpoint unavailable"));
    }
  });

  function start(onListening) {
    return http.createServer(app).listen(port, "127.0.0.1", () => {
      logger(`[production] scan API listening on 127.0.0.1:${port}`);
      if (onListening) onListening();
    });
  }

  return { app, start, runtime };
}

function validateScanRequest(scan) {
  if (!scan || typeof scan !== "object") return "invalid scan request";
  for (const key of [
    "event_id",
    "visit_id",
    "raw_scan_value",
    "room_id",
    "station_id",
    "device_id",
    "event_type",
    "source_type",
    "device_timestamp_utc",
  ]) {
    if (!scan[key]) return `missing ${key}`;
  }
  if (scan.event_type !== "scan_received" || scan.source_type !== "PI_SCANNER") {
    return "invalid scan request";
  }
  return null;
}

function normalizeCloudResponse(cloud) {
  const statusCode = Number(cloud && cloud.statusCode);
  const body = cloud && cloud.body && typeof cloud.body === "object" ? cloud.body : {};

  if (body.duplicate === true) {
    return {
      ok: false,
      disposition: "duplicate",
      duplicate: true,
      reason: "event already processed",
    };
  }

  if (statusCode >= 200 && statusCode < 300 && body.ok !== false) {
    return { ok: true, disposition: "accepted", duplicate: false, reason: null };
  }

  return {
    ok: false,
    disposition: "rejected",
    duplicate: false,
    reason: statusCode ? "cloud rejected scan" : "invalid cloud response",
  };
}

function unavailable(reason) {
  return { ok: false, disposition: "unavailable", duplicate: false, reason };
}

function postToCloud(urlString, payload, sharedSecret) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      reject(new Error("invalid cloud endpoint"));
      return;
    }

    const serialized = JSON.stringify(payload);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(serialized),
          Authorization: `Bearer ${sharedSecret}`,
        },
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk.toString();
        });
        response.on("end", () => {
          let body = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = null;
          }
          resolve({ statusCode: response.statusCode, body });
        });
      },
    );

    request.setTimeout(CLOUD_TIMEOUT_MS, () => request.destroy(new Error("cloud timeout")));
    request.on("error", reject);
    request.write(serialized);
    request.end();
  });
}

if (require.main === module) {
  createProductionScanServer({ logger: console.log }).start();
}

module.exports = {
  CLOUD_TIMEOUT_MS,
  createProductionScanServer,
  normalizeCloudResponse,
  validateScanRequest,
};
