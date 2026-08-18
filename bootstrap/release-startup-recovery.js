"use strict";

const fsDefault = require("fs");
const pathDefault = require("path");
const { execFile } = require("child_process");
const { createReleaseManager } = require("./lib/release-manager");

const RELEASE_ROOT = "/opt/multimedica-scanner/releases";
const STATE_ROOT = "/var/lib/multimedica-scanner/state";
const CURRENT_LINK = "/opt/multimedica-scanner/current";
const GATE_PATH = "/run/multimedica-scanner/production-allowed";
const PRODUCTION_UNIT = "multimedica-production.service";
const BLOCKING_STAGES = new Set(["first_activation_failed", "rollback_failed"]);
const SYSTEMCTL_TIMEOUT_MS = 5_000;

function createGateServiceController(deps = {}) {
  const fs = deps.fs || fsDefault;
  const path = deps.path || pathDefault;
  const gatePath = deps.gatePath || GATE_PATH;
  const runSystemctl = deps.runSystemctl || defaultRunSystemctl;
  const createGate = () => {
    if (fs.existsSync(gatePath)) return;
    fs.mkdirSync(path.dirname(gatePath), { recursive: true, mode: 0o755 });
    fs.writeFileSync(gatePath, "allowed\n", { flag: "wx", mode: 0o644 });
  };
  const removeGate = () => {
    try { fs.unlinkSync(gatePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  };
  const control = async (command, gated) => {
    if (gated) createGate();
    else removeGate();
    try {
      await runSystemctl(command, PRODUCTION_UNIT);
    } catch (error) {
      removeGate();
      throw error;
    }
  };
  return {
    enable: async () => {},
    restart: () => control("restart", true),
    start: () => control("start", true),
    stop: () => control("stop", false),
    disable: () => control("stop", false),
    removeGate,
    createGate,
  };
}

function defaultRunSystemctl(command, unit) {
  return new Promise((resolve, reject) => {
    execFile("systemctl", [command, unit], { shell: false, timeout: SYSTEMCTL_TIMEOUT_MS }, (error) => {
      if (error) reject(new Error("production service control failed"));
      else resolve();
    });
  });
}

function validateInstalledTarget(fs, path, stateStore, stateRoot, currentLink, releaseRoot) {
  const record = stateStore.readJson("installed-version.json", stateRoot);
  if (!record || typeof record.current_symlink !== "string") throw new Error("installed release record is missing");
  if (path.resolve(record.current_symlink) !== path.resolve(currentLink)) throw new Error("installed release link is invalid");
  const currentDir = safeReleasePath(record.current_dir, releaseRoot, path);
  const knownGoodDir = safeReleasePath(record.last_known_good_dir, releaseRoot, path);
  if (!currentDir && !knownGoodDir) throw new Error("installed release target is missing");
  if (!fs.existsSync(currentLink) || !fs.lstatSync(currentLink).isSymbolicLink()) throw new Error("current release link is invalid");
  const rawTarget = fs.readlinkSync(currentLink);
  const resolvedTarget = path.resolve(path.dirname(currentLink), rawTarget);
  if (resolvedTarget !== currentDir && resolvedTarget !== knownGoodDir) throw new Error("current release target is not known-good");
  return record;
}

function safeReleasePath(value, releaseRoot, path) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  const resolvedRoot = path.resolve(releaseRoot);
  const resolved = path.resolve(value);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("release target escapes release root");
  return resolved;
}

async function runStartupRecovery(deps = {}) {
  const fs = deps.fs || fsDefault;
  const path = deps.path || pathDefault;
  const roots = { stateRoot: deps.stateRoot || STATE_ROOT, releaseRoot: deps.releaseRoot || RELEASE_ROOT, currentLink: deps.currentLink || CURRENT_LINK };
  const gate = createGateServiceController({ fs, path, gatePath: deps.gatePath || GATE_PATH, runSystemctl: deps.runSystemctl });
  const logger = deps.logger || (() => {});
  gate.removeGate();
  let productionStopped = false;
  try {
    await gate.stop();
    productionStopped = true;
  } catch {
    gate.removeGate();
    logger("production stop failed");
    throw new Error("release startup recovery failed");
  }
  try {
    const manager = deps.releaseManager || createReleaseManager({
      roots,
      stateStore: deps.stateStore,
      serviceController: gate,
      productionHealthRequester: deps.productionHealthRequester,
      postPromotionVerifier: deps.postPromotionVerifier,
      rollbackVerifier: deps.rollbackVerifier,
      sleep: deps.sleep,
      clock: deps.clock,
    });
    const outcomes = await manager.reconcileInterruptedPromotions();
    if (outcomes.some((outcome) => BLOCKING_STAGES.has(outcome && outcome.stage))) throw new Error("release recovery blocked production");
    validateInstalledTarget(fs, path, deps.stateStore || require("./lib/state-store"), roots.stateRoot, roots.currentLink, roots.releaseRoot);
    await gate.restart();
    const health = await manager.waitForProductionHealth();
    if (!health) throw new Error("production health verification failed");
    return { ok: true, outcomes };
  } catch (error) {
    gate.removeGate();
    if (!productionStopped) {
      try { await gate.stop(); } catch { logger("production stop failed"); }
    }
    logger("release recovery failed");
    throw new Error("release startup recovery failed");
  }
}

async function main() {
  try {
    await runStartupRecovery({ logger: (message) => console.error(`[release-recovery] ${message}`) });
  } catch (error) {
    console.error(`[release-recovery] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  GATE_PATH,
  PRODUCTION_UNIT,
  createGateServiceController,
  runStartupRecovery,
  validateInstalledTarget,
};

if (require.main === module) main();
