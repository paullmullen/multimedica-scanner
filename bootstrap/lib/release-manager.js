"use strict";

/**
 * Local release staging and temporary candidate lifecycle.
 * This module never changes current/, enables services, or records known-good.
 */

const crypto = require("crypto");
const fsDefault = require("fs");
const pathDefault = require("path");
const { spawn } = require("child_process");
const http = require("http");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const stateStoreDefault = require("./state-store");
const { validateArtifact } = require("./release-artifact");

const CANDIDATE_PORT = 3003;
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
  const isPortAvailable = deps.isPortAvailable || defaultPortAvailable;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clock = deps.clock || (() => new Date());
  const logger = deps.logger || (() => {});
  const roots = Object.assign(
    {
      stateRoot: "/var/lib/multimedica-scanner/state",
      releaseRoot: "/opt/multimedica-scanner/releases",
    },
    deps.roots || {}
  );
  const candidates = new Map();
  const transactionSchema = loadTransactionSchema(fs, path);
  const validateTransaction = createValidator(transactionSchema);

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

  return { stageArtifact, startCandidate, stopCandidate, abandonStaging, readTransaction, roots };
}

function requireLocalArtifact(options, fs, path) {
  if (!options || typeof options.version !== "string" || typeof options.expectedSha256 !== "string") throw new Error("release artifact options are incomplete");
  const artifactPath = path.resolve(options.artifactPath || "");
  if (!fs.existsSync(artifactPath) || !fs.lstatSync(artifactPath).isFile() || fs.lstatSync(artifactPath).isSymbolicLink()) {
    throw new Error("local release artifact is invalid");
  }
  return artifactPath;
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
