"use strict";

/**
 * Wi-Fi Manager — Multimedica Scanner Bootstrap Layer
 *
 * Applies Wi-Fi configuration via nmcli on Linux.
 *
 * SECURITY: the Wi-Fi password is accepted as a parameter and passed
 * directly to nmcli via execFile (no shell expansion).  It is never
 * logged, echoed, or included in error messages.
 *
 * On non-Linux platforms this module throws with a clear message so
 * the controller can skip the apply step during development.
 */

const { execFile } = require("child_process");

const DEFAULT_TIMEOUT_MS = Number(process.env.WIFI_TIMEOUT_MS || 60_000);
const CMD_TIMEOUT_MS = Number(process.env.WIFI_CMD_TIMEOUT_MS || 30_000);

// ---------------------------------------------------------------------------
// Internal command helpers
// ---------------------------------------------------------------------------

function _run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs || CMD_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject({ error: err, stdout: stdout || "", stderr: stderr || "" });
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function _runAllowFailure(cmd, args) {
  try {
    return await _run(cmd, args);
  } catch (err) {
    return { failed: true, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Apply Wi-Fi configuration using nmcli.
 *
 * @param {{ ssid: string, password: string, security?: string }} opts
 * @throws if nmcli commands fail or the platform is not Linux
 */
async function applyWifiConfig({ ssid, password, security = "wpa-psk" }) {
  if (!ssid) throw new Error("Missing Wi-Fi SSID");
  if (password === undefined) throw new Error("Missing Wi-Fi password field");
  if (process.platform !== "linux") {
    throw new Error("Wi-Fi configuration requires Linux/nmcli");
  }

  console.log("[wifi-manager] configuring SSID:", ssid, "(password not logged)");

  // Delete any existing connection with this SSID
  const existing = await _runAllowFailure("sudo", [
    "/usr/bin/nmcli",
    "-t",
    "-f",
    "UUID,NAME,TYPE",
    "connection",
    "show",
  ]);
  if (!existing.failed && existing.stdout) {
    const toDelete = existing.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [uuid, name, type] = l.split(":");
        return { uuid, name, type };
      })
      .filter((c) => c.name === ssid && c.type === "802-11-wireless")
      .map((c) => c.uuid);
    for (const uuid of toDelete) {
      await _runAllowFailure("sudo", ["/usr/bin/nmcli", "connection", "delete", uuid]);
    }
  }

  // Add new connection
  await _run("sudo", [
    "/usr/bin/nmcli",
    "connection",
    "add",
    "type",
    "wifi",
    "ifname",
    "wlan0",
    "con-name",
    ssid,
    "ssid",
    ssid,
  ]);

  // Set security key management
  const keyMgmt = security === "none" ? "none" : "wpa-psk";
  await _run("sudo", [
    "/usr/bin/nmcli",
    "connection",
    "modify",
    ssid,
    "wifi-sec.key-mgmt",
    keyMgmt,
  ]);

  // Set password (never logged; passed via execFile, not shell)
  if (keyMgmt !== "none" && password) {
    await _run("sudo", ["/usr/bin/nmcli", "connection", "modify", ssid, "wifi-sec.psk", password]);
  }

  // Enable autoconnect
  await _run("sudo", [
    "/usr/bin/nmcli",
    "connection",
    "modify",
    ssid,
    "connection.autoconnect",
    "yes",
  ]);

  // Bring up the connection
  await _run("sudo", ["/usr/bin/nmcli", "connection", "up", ssid], DEFAULT_TIMEOUT_MS);

  console.log("[wifi-manager] Wi-Fi configured for SSID:", ssid);
}

module.exports = { applyWifiConfig };
