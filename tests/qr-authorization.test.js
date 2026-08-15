"use strict";

const Ajv = require("ajv");
const fs = require("fs");
const path = require("path");

const bootstrapQr = require("../bootstrap/lib/qr-contract");

process.env.SCANNER_QR_ADMIN_TOKEN = "fake-token";
const legacyQr = require("../configQr");
delete process.env.SCANNER_QR_ADMIN_TOKEN;

const TEST_TOKEN = "fake-token";
const schema = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../schemas/qr-envelope.schema.json"), "utf8")
);
const validateEnvelope = new Ajv({ allErrors: true }).compile(schema);

function qr(kind, payload, auth) {
  const data = { kind, version: 1, payload };
  if (auth !== undefined) data.auth = auth;
  return `MMCFG:${JSON.stringify(data)}`;
}

describe.each([
  ["bootstrap", bootstrapQr.handleConfigQr],
  ["legacy", legacyQr.handleConfigQr],
])("%s QR authorization", (_name, handleConfigQr) => {
  test("show_identity accepts empty payload without auth", () => {
    expect(handleConfigQr(qr("show_identity", {}), null).ok).toBe(true);
    expect(validateEnvelope(JSON.parse(qr("show_identity", {}).slice(6)))).toBe(true);
  });

  test("show_identity rejects configuration fields", () => {
    const value = JSON.parse(qr("show_identity", { device_id: "fake-device" }).slice(6));
    expect(handleConfigQr(`MMCFG:${JSON.stringify(value)}`, null).ok).toBe(false);
    expect(validateEnvelope(value)).toBe(false);
  });

  test("protected kinds require a valid admin token", () => {
    for (const kind of ["wifi_config", "station_config", "cloud_config"]) {
      const payload =
        kind === "wifi_config"
          ? { ssid: "fake-network", password: "fake-password" }
          : kind === "station_config"
            ? {
                location_id: "fake-location",
                room_id: "fake-room",
                station_id: "fake-station",
                device_id: "fake-device",
              }
            : {
                endpoint_url: "https://example.invalid",
                shared_secret: "fake-shared-secret",
              };
      expect(handleConfigQr(qr(kind, payload), TEST_TOKEN).ok).toBe(false);
      expect(handleConfigQr(qr(kind, payload, { admin_token: "wrong-token" }), TEST_TOKEN).ok).toBe(
        false
      );
      expect(validateEnvelope(JSON.parse(qr(kind, payload).slice(6)))).toBe(false);
    }
  });
});
