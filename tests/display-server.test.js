"use strict";

/**
 * Display Server Tests
 *
 * Tests for bootstrap/display-server.js HTTP endpoints.
 * No secrets are used; this module never stores secrets.
 */

const http = require("http");
const path = require("path");

// We start a fresh display-server instance for each test via a separate require
// and a dynamic port to avoid conflicts.

let app, server, getState, resetState;
const TEST_PORT = 14000 + Math.floor(Math.random() * 100);

beforeAll((done) => {
  process.env.DISPLAY_PORT = String(TEST_PORT);
  // Re-require the module fresh so it picks up the env var
  jest.resetModules();
  const mod = require("../bootstrap/display-server");
  app = mod.app;
  server = mod.server;
  getState = mod.getState;
  resetState = mod.resetState;
  // Wait for server to be listening
  if (server.listening) return done();
  server.once("listening", done);
});

afterAll((done) => {
  delete process.env.DISPLAY_PORT;
  if (server) server.close(done);
  else done();
});

beforeEach(() => {
  if (resetState) resetState();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${TEST_PORT}${path}`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
      })
      .on("error", reject);
  });
}

function post(pathname, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const opts = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

test("GET /api/health returns ok", async () => {
  const { statusCode, body } = await get("/api/health");
  expect(statusCode).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.service).toBe("multimedica-display");
});

// ---------------------------------------------------------------------------
// GET /api/state
// ---------------------------------------------------------------------------

test("GET /api/state returns initial state", async () => {
  const { statusCode, body } = await get("/api/state");
  expect(statusCode).toBe(200);
  expect(typeof body.commissioning_state).toBe("string");
  expect(Array.isArray(body.missing_fields)).toBe(true);
});

// ---------------------------------------------------------------------------
// POST /api/state
// ---------------------------------------------------------------------------

test("POST /api/state with state and missing updates the stored state", async () => {
  const { body } = await post("/api/state", {
    state: "network_configured",
    complete: false,
    missing: ["station_config", "cloud_config"],
  });
  expect(body.ok).toBe(true);

  const { body: state } = await get("/api/state");
  expect(state.commissioning_state).toBe("network_configured");
  expect(state.configuration_complete).toBe(false);
  expect(state.missing_fields).toContain("station_config");
});

test("POST /api/state with message stores kind and text", async () => {
  await post("/api/state", { message: { kind: "success", text: "Wi-Fi accepted" } });
  const { body } = await get("/api/state");
  expect(body.message.kind).toBe("success");
  expect(body.message.text).toBe("Wi-Fi accepted");
});

test("POST /api/state with identity stores non-secret fields", async () => {
  await post("/api/state", {
    identity: { location_id: "loc1", room_id: "r1", station_id: "s1", device_id: "d1" },
  });
  const { body } = await get("/api/state");
  expect(body.identity.station_id).toBe("s1");
  expect(body.identity.location_id).toBe("loc1");
});

test("POST /api/state strips unrecognised fields from identity", async () => {
  await post("/api/state", {
    identity: {
      location_id: "loc1",
      room_id: "r1",
      station_id: "s1",
      device_id: "d1",
      shared_secret: "must-not-be-stored", // should be discarded
      qr_admin_token: "also-must-not-store", // should be discarded
    },
  });
  const { body } = await get("/api/state");
  expect(body.identity).not.toHaveProperty("shared_secret");
  expect(body.identity).not.toHaveProperty("qr_admin_token");
  expect(JSON.stringify(body.identity)).not.toContain("must-not-be-stored");
});

test("POST /api/state with null identity clears identity panel", async () => {
  await post("/api/state", {
    identity: { station_id: "s1", location_id: "l1", room_id: "r1", device_id: "d1" },
  });
  await post("/api/state", { identity: null });
  const { body } = await get("/api/state");
  expect(body.identity).toBeNull();
});

test("POST /api/state does not store extra fields from body", async () => {
  await post("/api/state", { state: "bootstrap_installed", evil_field: "should-be-ignored" });
  const { body } = await get("/api/state");
  expect(body).not.toHaveProperty("evil_field");
});

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

test("GET / serves index.html", (done) => {
  http
    .get(`http://127.0.0.1:${TEST_PORT}/`, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        expect(res.statusCode).toBe(200);
        expect(body).toContain("Multimedica");
        done();
      });
    })
    .on("error", done);
});
