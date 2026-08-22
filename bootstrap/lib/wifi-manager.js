"use strict";

/**
 * Wi-Fi Manager - unprivileged controller side.
 *
 * Sends one JSON document to the fixed, root-owned helper over stdin. The
 * password is never placed in argv, stdout, stderr, or an environment value.
 */

const { spawn } = require("child_process");

const HELPER = "/usr/local/sbin/multimedica-wifi-apply";
const DEFAULT_TIMEOUT_MS = Number(process.env.WIFI_TIMEOUT_MS || 90_000);

function _runHelper(payload, { spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("sudo", ["-n", HELPER], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let settled = false;
    let safeFailure = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Wi-Fi configuration timed out"));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    child.stderr.on("data", (chunk) => {
      const match = chunk.toString().match(
        /WIFI_APPLY_FAILED:[a-z-]+:[a-z-]+:rollback-(?:not-needed|restored|failed)/
      );
      if (match) safeFailure = match[0];
    });
    child.on("error", () => finish(new Error("Wi-Fi configuration helper unavailable")));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(safeFailure || "Wi-Fi configuration failed"));
    });

    // JSON is written only to the helper's stdin. Do not log payload.
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

async function applyWifiConfig({ ssid, password, security = "wpa-psk" }, deps) {
  if (!ssid) throw new Error("Missing Wi-Fi SSID");
  if (password === undefined) throw new Error("Missing Wi-Fi password field");
  if (process.platform !== "linux" && !deps?.allowNonLinux) {
    throw new Error("Wi-Fi configuration requires Linux/NetworkManager");
  }
  console.log("[wifi-manager] configuring SSID:", ssid, "(password not logged)");
  await _runHelper({ ssid, password, security }, deps);
  console.log("[wifi-manager] Wi-Fi configured for SSID:", ssid);
}

module.exports = { applyWifiConfig, _runHelper, HELPER };
