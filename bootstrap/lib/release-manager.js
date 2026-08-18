"use strict";

/**
 * Local release staging and temporary candidate lifecycle.
 * This module never changes current/, enables services, or records known-good.
 */

const crypto = require("crypto");
const fsDefault = require("fs");
const pathDefault = require("path");
const { spawn } = require("child_process");
const { execFile } = require("child_process");
const http = require("http");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const stateStoreDefault = require("./state-store");
const { validateArtifact } = require("./release-artifact");

const CANDIDATE_PORT = 3003;
const PRODUCTION_PORT = 3002;
const HEALTH_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;

function createReleaseManager(deps = {}) {
  const fs = deps.fs || fsDefault;
  const path = deps.path || pathDefault;
  const stateStore = deps.stateStore || stateStoreDefault;
  const artifactValidator = deps.artifactValidator || validateArtifact;
  const commandRunner = deps.commandRunner || defaultCommandRunner;
  const processLauncher = deps.processLauncher || defaultProcessLauncher;
  const healthRequester = deps.healthRequester || defaultHealthRequester;
  const productionHealthRequester = deps.productionHealthRequester || defaultHealthRequester;
  const serviceController = deps.serviceController || defaultServiceController;
  const postPromotionVerifier = deps.postPromotionVerifier || defaultPromotionVerifier;
  const rollbackVerifier = deps.rollbackVerifier || defaultPromotionVerifier;
  const switchCurrent = deps.switchCurrent || ((target, transactionId) => atomicallySwitchCurrent(fs, path, roots.currentLink, target, transactionId));
  const isPortAvailable = deps.isPortAvailable || defaultPortAvailable;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = deps.clock || (() => new Date());
  const logger = deps.logger || (() => {});
  const roots = Object.assign(
    {
      stateRoot: "/var/lib/multimedica-scanner/state",
      releaseRoot: "/opt/multimedica-scanner/releases",
      currentLink: "/opt/multimedica-scanner/current",
    },
    deps.roots || {}
  );
  const candidates = new Map();
  const transactionSchema = loadTransactionSchema(fs, path);
  const validateTransaction = createValidator(transactionSchema);
  const installedVersionSchema = loadInstalledVersionSchema(fs, path);
  const validateInstalledRecord = createValidator(installedVersionSchema);

  const transactionRoot = resolveInside(roots.stateRoot, "releases/transactions", path);
  const artifactRoot = resolveInside(roots.stateRoot, "releases/staging", path);
  const stagingRoot = resolveInside(roots.releaseRoot, "staging", path);

  function transactionName(transactionId) {
    return `releases/transactions/${transactionId}.json`;
  }

  function readTransaction(transactionId) {
    const transaction = stateStore.readJson(transactionName(transactionId), roots.stateRoot);
    if (!transaction) throw new Error("release transaction not found");
    return transaction;
  }

  function writeTransaction(transaction) {
    assertSafeTransaction(transaction);
    if (!validateTransaction(transaction)) throw new Error("release transaction schema validation failed");
    stateStore.writeJson(transactionName(transaction.txn_id), transaction, roots.stateRoot);
    return transaction;
  }

  function updateTransaction(transaction, stage, extra = {}) {
    transaction.stage = stage;
    if (!transaction.stages_completed.includes(stage)) transaction.stages_completed.push(stage);
    Object.assign(transaction, extra);
    return writeTransaction(transaction);
  }

  async function stageArtifact(options) {
    const artifactPath = requireLocalArtifact(options, fs, path);
    const artifactBytes = fs.readFileSync(artifactPath);
    const validated = artifactValidator(artifactBytes, options.expectedSha256);
    validateCompatibility(validated.manifest, options.version);
    assertValidatedEntries(validated.entries, path);

    const transactionId = options.transactionId || crypto.randomUUID();
    const existing = tryReadTransaction(transactionId);
    if (existing && existing.target_version !== options.version) throw new Error("transaction version mismatch");
    if (!existing) assertVersionNotStaged(options.version);

    const artifactCopy = resolveInside(artifactRoot, `${transactionId}.tgz`, path);
    const stagingDir = resolveInside(stagingRoot, transactionId, path);
    if (fs.existsSync(artifactCopy) || fs.existsSync(stagingDir)) throw new Error("release staging collision");

    let transaction = {
      txn_id: transactionId,
      started_at: clock().toISOString(),
      target_version: options.version,
      stage: "resolving",
      stages_completed: ["resolving"],
      artifact_path: artifactCopy,
      staging_dir: stagingDir,
      candidate_pid: null,
      candidate_manifest: safeManifest(validated.manifest),
      rollback_target: null,
      error: null,
      completed_at: null,
    };
    writeTransaction(transaction);

    try {
      mkdir(fs, path.dirname(artifactCopy));
      fs.writeFileSync(artifactCopy, artifactBytes, { flag: "wx" });
      transaction = updateTransaction(transaction, "downloaded");
      transaction = updateTransaction(transaction, "checksum_verified");
      transaction = updateTransaction(transaction, "compatibility_verified");

      mkdir(fs, stagingDir);
      for (const entry of validated.entries) writeValidatedEntry(fs, path, stagingDir, entry);
      transaction = updateTransaction(transaction, "extracted");

      const npmResult = await commandRunner(npmCommand(), ["ci", "--omit=dev", "--ignore-scripts"], {
        cwd: stagingDir,
        env: Object.assign({}, process.env),
        shell: false,
      });
      if (!npmResult || npmResult.code !== 0) throw new Error("dependency installation failed");
      transaction = updateTransaction(transaction, "deps_installed");
      return safeTransaction(transaction);
    } catch (error) {
      updateTransaction(transaction, failureStage(transaction.stage), { error: "release staging failed" });
      throw new Error("release staging failed");
    }
  }

  async function startCandidate(transactionId) {
    const transaction = readTransaction(transactionId);
    if (transaction.stage !== "deps_installed") throw new Error("release transaction is not ready for candidate startup");
    if (!isInside(stagingRoot, transaction.staging_dir, path)) throw new Error("invalid release staging path");
    const entryPath = resolveInside(transaction.staging_dir, "production/scan-server.js", path);
    if (!fs.existsSync(entryPath)) throw new Error("candidate entrypoint is missing");
    if (!(await isPortAvailable(CANDIDATE_PORT))) throw new Error("candidate port 3003 is already occupied");

    const child = await processLauncher(process.execPath, [entryPath], {
      cwd: transaction.staging_dir,
      shell: false,
      env: Object.assign({}, process.env, {
        MULTIMEDICA_STATE_DIR: roots.stateRoot,
        PRODUCTION_PORT: String(CANDIDATE_PORT),
        MULTIMEDICA_DISABLE_BOOT_SYNC: "1",
      }),
    });
    if (!child || !Number.isInteger(child.pid)) throw new Error("candidate process did not start");
    candidates.set(transactionId, child);
    updateTransaction(transaction, "candidate_started", { candidate_pid: child.pid });

    const health = await waitForCandidateHealth();
    if (!health) {
      await stopCandidate(transactionId);
      updateTransaction(transaction, "failed", { candidate_pid: null, error: "candidate health failed" });
      throw new Error("candidate health check failed");
    }
    updateTransaction(transaction, "candidate_health_passed", { candidate_pid: child.pid });
    return { transactionId, pid: child.pid, port: CANDIDATE_PORT, health };
  }

  async function stopCandidate(transactionId) {
    const transaction = readTransaction(transactionId);
    const child = candidates.get(transactionId);
    if (child) {
      await terminateChild(child, sleep);
      candidates.delete(transactionId);
    }
    if (!(await isPortAvailable(CANDIDATE_PORT))) throw new Error("candidate port 3003 was not released");
    if (transaction.stage !== "candidate_stopped") updateTransaction(transaction, "candidate_stopped", { candidate_pid: null });
    return safeTransaction(transaction);
  }

  async function promoteCandidate(transactionId) {
    const lockPath = resolveInside(roots.releaseRoot, ".promotion-lock", path);
    acquirePromotionLock(fs, lockPath);
    let symlinkChanged = false;
    let transaction;
    let previousTarget = null;
    let installedBefore = null;
    try {
      transaction = readTransaction(transactionId);
      assertPromotionPreconditions(transaction, transactionId, candidates, stagingRoot, roots.releaseRoot, fs, path);
      installedBefore = stateStore.readJson("installed-version.json", roots.stateRoot);
      previousTarget = readCurrentTarget(fs, path, roots.currentLink, roots.releaseRoot);
      transaction = updateTransaction(transaction, "promotion_started", {
        rollback_target: previousTarget,
      });

      await stopCandidate(transactionId);
      transaction = readTransaction(transactionId);
      const versionDir = resolveInside(roots.releaseRoot, transaction.target_version, path);
      if (fs.existsSync(versionDir)) throw new Error("release version directory already exists");
      if (!isInside(stagingRoot, transaction.staging_dir, path)) throw new Error("invalid release staging path");
      fs.renameSync(transaction.staging_dir, versionDir);
      transaction = updateTransaction(transaction, "version_dir_renamed");
      createSiblingSymlink(fs, path, versionDir, `${versionDir}.${transactionId}.linktmp`, "release link");
      removeIfExists(fs, `${versionDir}.${transactionId}.linktmp`);
      switchCurrent(versionDir, transactionId);
      symlinkChanged = true;
      transaction = updateTransaction(transaction, "symlink_updated");

      await serviceController.enable();
      await serviceController.restart();
      transaction = updateTransaction(transaction, "production_started");
      const health = await waitForProductionHealth(productionHealthRequester, sleep);
      if (!health) throw new Error("production health failed");
      transaction = updateTransaction(transaction, "production_health_passed");
      const verification = await postPromotionVerifier({ transactionId, version: transaction.target_version, releaseDir: versionDir });
      if (!verifierPassed(verification)) throw new Error("post-promotion verification failed");
      transaction = updateTransaction(transaction, "post_promotion_verified");

      const installed = createInstalledVersion(transaction, versionDir, previousTarget, installedBefore, roots.currentLink, clock);
      validateInstalledVersion(installed, roots.releaseRoot, path, validateInstalledRecord);
      stateStore.writeJson("installed-version.json", installed, roots.stateRoot);
      transaction = updateTransaction(transaction, "known_good_promoted");
      transaction = updateTransaction(transaction, "complete", { completed_at: clock().toISOString(), candidate_pid: null });
      return safeTransaction(transaction);
    } catch (error) {
      if (!transaction) throw new Error("release promotion failed");
      if (!symlinkChanged) {
        try { await stopCandidate(transactionId); } catch { /* preserve the original safe failure */ }
        updateTransaction(transaction, "failed", { error: safePromotionError(error) });
        throw new Error("release promotion failed");
      }
      const rollback = await automaticRollback({ transaction, previousTarget, installedBefore });
      if (rollback.ok) {
        updateTransaction(transaction, rollback.stage || "rolled_back", { error: rollback.error });
        throw new Error("release promotion rolled back");
      }
      updateTransaction(transaction, "rollback_failed", { error: "rollback_failed" });
      throw new Error("release promotion rollback failed");
    } finally {
      removeIfExists(fs, lockPath);
    }
  }

  async function automaticRollback({ transaction, previousTarget }) {
    try {
      await serviceController.stop();
      if (previousTarget) {
        switchCurrent(previousTarget, transaction.txn_id);
        await serviceController.restart();
        if (!await waitForProductionHealth(productionHealthRequester, sleep)) throw new Error("rollback health failed");
        const verification = await rollbackVerifier({ transactionId: transaction.txn_id, version: path.basename(previousTarget), releaseDir: previousTarget });
        if (!verifierPassed(verification)) throw new Error("rollback verification failed");
        return { ok: true, error: "promotion_failed_rolled_back" };
      }
      removeIfExists(fs, roots.currentLink);
      await serviceController.disable();
      return { ok: true, stage: "first_activation_failed", error: "first_activation_failed" };
    } catch {
      try { await serviceController.disable(); } catch { /* retain bounded failure code */ }
      return { ok: false };
    }
  }

  async function abandonStaging(transactionId) {
    const transaction = readTransaction(transactionId);
    if (["version_dir_renamed", "symlink_updated", "production_started", "complete"].includes(transaction.stage)) {
      throw new Error("cannot abandon a promoted release transaction");
    }
    await stopCandidate(transactionId);
    if (isInside(stagingRoot, transaction.staging_dir, path)) fs.rmSync(transaction.staging_dir, { recursive: true, force: true });
    if (isInside(artifactRoot, transaction.artifact_path, path)) fs.rmSync(transaction.artifact_path, { force: true });
    updateTransaction(transaction, "abandoned", { candidate_pid: null, error: "staging abandoned" });
    return safeTransaction(transaction);
  }

  async function waitForCandidateHealth() {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const status = await healthRequester(`http://127.0.0.1:${CANDIDATE_PORT}/api/status`);
        const acceptable =
          status &&
          status.service === "multimedica-production" &&
          status.ok === true &&
          status.state === "healthy" &&
          status && typeof status === "object" && !Array.isArray(status);
        if (acceptable) return status;
      } catch {
        // bounded retry; no raw response is retained
      }
      await sleep(100);
    }
    return null;
  }

  function tryReadTransaction(transactionId) {
    return stateStore.readJson(transactionName(transactionId), roots.stateRoot);
  }

  function assertVersionNotStaged(version) {
    if (!fs.existsSync(transactionRoot)) return;
    for (const file of fs.readdirSync(transactionRoot)) {
      if (!file.endsWith(".json")) continue;
      const transaction = stateStore.readJson(`releases/transactions/${file}`, roots.stateRoot);
      if (transaction && transaction.target_version === version && !["abandoned", "failed"].includes(transaction.stage)) {
        throw new Error("release version is already staged");
      }
    }
  }

  return { stageArtifact, startCandidate, stopCandidate, promoteCandidate, abandonStaging, readTransaction, roots };
}

function requireLocalArtifact(options, fs, path) {
  if (!options || typeof options.version !== "string" || typeof options.expectedSha256 !== "string") throw new Error("release artifact options are incomplete");
  const artifactPath = path.resolve(options.artifactPath || "");
  if (!fs.existsSync(artifactPath) || !fs.lstatSync(artifactPath).isFile() || fs.lstatSync(artifactPath).isSymbolicLink()) {
    throw new Error("local release artifact is invalid");
  }
  return artifactPath;
}

function safeManifest(manifest) {
  return {
    version: manifest.version,
    entry_point: manifest.entry_point,
    candidate_port: manifest.candidate_port,
    os_id: manifest.os_id,
    arch: manifest.arch,
    capability_policy: manifest.capability_policy,
  };
}

function assertPromotionPreconditions(transaction, transactionId, candidates, stagingRoot, releaseRoot, fs, path) {
  if (transaction.stage !== "candidate_health_passed") throw new Error("release candidate is not health verified");
  const candidate = candidates.get(transactionId);
  if (!candidate || candidate.pid !== transaction.candidate_pid) throw new Error("candidate does not belong to transaction");
  if (!transaction.candidate_manifest || transaction.candidate_manifest.version !== transaction.target_version) {
    throw new Error("candidate manifest does not match transaction");
  }
  if (transaction.candidate_manifest.candidate_port !== CANDIDATE_PORT) throw new Error("candidate manifest port is invalid");
  if (!isInside(stagingRoot, transaction.staging_dir, path)) throw new Error("invalid release staging path");
  const finalDir = resolveInside(releaseRoot, transaction.target_version, path);
  if (fs.existsSync(finalDir)) throw new Error("release version directory already exists");
}

function acquirePromotionLock(fs, lockPath) {
  try {
    fs.mkdirSync(lockPath, { recursive: false, mode: 0o750 });
  } catch {
    throw new Error("release promotion is already active or has a stale lock");
  }
}

function readCurrentTarget(fs, path, currentLink, releaseRoot) {
  if (!fs.existsSync(currentLink) && !isSymlink(fs, currentLink)) return null;
  const stat = fs.lstatSync(currentLink);
  if (!stat.isSymbolicLink()) throw new Error("current release target is not a symlink");
  const rawTarget = fs.readlinkSync(currentLink);
  const resolved = path.resolve(path.dirname(currentLink), rawTarget);
  if (!isInside(releaseRoot, resolved, path)) throw new Error("current release target is outside release root");
  return resolved;
}

function isSymlink(fs, target) {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

function createSiblingSymlink(fs, path, target, temporary, label) {
  removeIfExists(fs, temporary);
  fs.symlinkSync(target, temporary, process.platform === "win32" ? "junction" : "dir");
  if (!isSymlink(fs, temporary)) throw new Error(`${label} was not created atomically`);
}

function atomicallySwitchCurrent(fs, path, currentLink, target, transactionId) {
  const releaseRoot = path.dirname(currentLink);
  const temporary = path.join(releaseRoot, `.current.${transactionId}.tmp`);
  createSiblingSymlink(fs, path, target, temporary, "current release link");
  try {
    fs.renameSync(temporary, currentLink);
  } catch (error) {
    removeIfExists(fs, temporary);
    throw error;
  }
}

function removeIfExists(fs, target) {
  try {
    if (isSymlink(fs, target)) fs.unlinkSync(target);
    else if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; the owning operation reports its bounded failure.
  }
}

function createInstalledVersion(transaction, versionDir, previousTarget, previousRecord, currentLink, clock) {
  const previousVersion = previousTarget ? pathBase(previousTarget) : null;
  return {
    current_version: transaction.target_version,
    current_dir: versionDir,
    current_symlink: currentLink,
    previous_version: previousVersion,
    previous_dir: previousTarget,
    last_known_good_version: transaction.target_version,
    last_known_good_dir: versionDir,
    last_activation_at: clock().toISOString(),
    last_activation_txn: transaction.txn_id,
  };
}

function pathBase(value) {
  return value.split(/[\\/]/).filter(Boolean).pop();
}

function validateInstalledVersion(record, releaseRoot, path, validateRecord) {
  if (!record.current_dir || !record.current_symlink || !record.last_known_good_dir) throw new Error("installed version record is incomplete");
  if (!path.isAbsolute(record.current_dir) || !path.isAbsolute(record.last_known_good_dir)) throw new Error("installed version paths are invalid");
  if (!isInside(releaseRoot, record.current_dir, path) || !isInside(releaseRoot, record.last_known_good_dir, path)) throw new Error("installed version paths escape release root");
  if (!validateRecord(record)) throw new Error("installed version record is invalid");
}

async function waitForProductionHealth(requester, sleep) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await requester(`http://127.0.0.1:${PRODUCTION_PORT}/api/status`);
      const status = response && response.body && typeof response.statusCode === "number" ? response.body : response;
      const code = response && typeof response.statusCode === "number" ? response.statusCode : 200;
      if (code >= 200 && code < 300 && status && typeof status === "object" && !Array.isArray(status) &&
        status.service === "multimedica-production" && status.ok === true && status.state === "healthy") return status;
    } catch {
      // bounded retry; no response is retained
    }
    await sleep(100);
  }
  return null;
}

function verifierPassed(result) {
  return result === true || Boolean(result && result.ok === true);
}

function defaultPromotionVerifier() {
  throw new Error("post-promotion verifier is required");
}

function defaultServiceController() {
  const unit = "multimedica-production.service";
  const run = (command) => new Promise((resolve, reject) => {
    execFile("systemctl", [command, unit], { shell: false, timeout: HEALTH_TIMEOUT_MS }, (error) => {
      if (error) reject(new Error("production service control failed"));
      else resolve();
    });
  });
  return {
    enable: () => run("enable"),
    restart: () => run("restart"),
    stop: () => run("stop"),
    disable: () => run("disable"),
  };
}

function safePromotionError() {
  return "promotion_failed";
}

function validateCompatibility(manifest, version) {
  if (manifest.version !== version) throw new Error("release version does not match manifest");
  if (manifest.candidate_port !== CANDIDATE_PORT) throw new Error("release candidate port is invalid");
  if (manifest.os_id !== "debian-13-trixie-arm64" || manifest.arch !== "arm64" || manifest.capability_policy !== "capability-qualified") {
    throw new Error("release compatibility contract is invalid");
  }
}

function assertValidatedEntries(entries, path) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("validated artifact entries are missing");
  for (const entry of entries) {
    if (!entry || !Buffer.isBuffer(entry.content) || !isSafeRelative(entry.path, path)) throw new Error("validated artifact entry is unsafe");
  }
}

function writeValidatedEntry(fs, path, root, entry) {
  const destination = resolveInside(root, entry.path, path);
  mkdir(fs, path.dirname(destination));
  if (fs.existsSync(destination)) throw new Error("release extraction collision");
  fs.writeFileSync(destination, entry.content, { flag: "wx" });
}

function resolveInside(root, candidate, path) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  if (!isInside(resolvedRoot, resolved, path)) throw new Error("path escapes configured release root");
  return resolved;
}

function isInside(root, candidate, path) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function isSafeRelative(value, path) {
  return typeof value === "string" && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

function mkdir(fs, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

function createValidator(schema) {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function loadTransactionSchema(fs, path) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "schemas", "release-transaction.schema.json"), "utf8"));
}

function loadInstalledVersionSchema(fs, path) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "schemas", "installed-version.schema.json"), "utf8"));
}

function assertSafeTransaction(transaction) {
  const serialized = JSON.stringify(transaction);
  if (serialized.includes("shared_secret") || serialized.includes("raw_scan") || serialized.includes("barcode")) {
    throw new Error("release transaction contains forbidden data");
  }
}

function safeTransaction(transaction) {
  return {
    transactionId: transaction.txn_id,
    version: transaction.target_version,
    stage: transaction.stage,
    candidatePid: transaction.candidate_pid,
  };
}

function failureStage(stage) {
  return stage === "deps_installed" ? "failed" : "failed";
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function defaultCommandRunner(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, Object.assign({}, options, { stdio: "ignore", shell: false }));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code }));
  });
}

function defaultProcessLauncher(command, args, options) {
  return spawn(command, args, Object.assign({}, options, { stdio: "ignore", shell: false }));
}

function defaultHealthRequester(urlString) {
  return new Promise((resolve, reject) => {
    const request = http.get(urlString, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error("candidate health status"));
        try { resolve(JSON.parse(raw)); } catch { reject(new Error("candidate health body")); }
      });
    });
    request.setTimeout(HEALTH_TIMEOUT_MS, () => request.destroy(new Error("candidate health timeout")));
    request.on("error", reject);
  });
}

function defaultPortAvailable(port) {
  const net = require("net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function terminateChild(child, sleep) {
  if (!child || typeof child.kill !== "function") return;
  child.kill("SIGTERM");
  if (typeof child.waitForExit === "function") {
    const stopped = await child.waitForExit(STOP_TIMEOUT_MS);
    if (stopped) return;
  } else {
    await sleep(STOP_TIMEOUT_MS);
  }
  child.kill("SIGKILL");
  if (typeof child.waitForExit === "function") await child.waitForExit(STOP_TIMEOUT_MS);
}

module.exports = { CANDIDATE_PORT, createReleaseManager };
