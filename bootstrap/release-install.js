"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { execFile } = require("child_process");
const http = require("http");
const net = require("net");
const { createReleaseManager } = require("./lib/release-manager");

const TRANSFER_ROOT = "/var/lib/multimedica-scanner/release-transfer";
const OPERATION_ROOT = "/var/lib/multimedica-scanner/release-operation";
const LOCK_PATH = path.join(OPERATION_ROOT, "operation.lock");
const RELEASE_ROOT = "/opt/multimedica-scanner/releases";
const STATE_ROOT = "/var/lib/multimedica-scanner/state";
const CURRENT_LINK = "/opt/multimedica-scanner/current";
const GATE_PATH = "/run/multimedica-scanner/production-allowed";
const PRODUCTION_UNIT = "multimedica-production.service";
const RECOVERY_UNIT = "multimedica-release-recovery.service";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HASH = /^[0-9a-f]{64}$/i;
const PRODUCTION_PORT = 3002;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key ||
      !value ||
      !["--version", "--artifact-name", "--sha256"].includes(key) ||
      values[key]
    )
      throw new Error("invalid release installation arguments");
    values[key] = value;
  }
  if (!SEMVER.test(values["--version"] || "") || !HASH.test(values["--sha256"] || ""))
    throw new Error("release version or hash is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(values["--artifact-name"] || ""))
    throw new Error("artifact name is invalid");
  return {
    version: values["--version"],
    artifactName: values["--artifact-name"],
    expectedSha256: values["--sha256"].toLowerCase(),
  };
}

function claimArtifact(artifactName, transferRoot = TRANSFER_ROOT, operationRoot = OPERATION_ROOT) {
  const source = path.join(transferRoot, artifactName);
  const claimed = path.join(operationRoot, `${process.pid}-${artifactName}`);
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1)
    throw new Error("uploaded artifact is unsafe");
  fs.renameSync(source, claimed);
  fs.chownSync(claimed, 0, 0);
  fs.chmodSync(claimed, 0o600);
  const claimedStat = fs.lstatSync(claimed);
  if (
    path.resolve(claimed) !==
      path.resolve(path.join(operationRoot, `${process.pid}-${artifactName}`)) ||
    !claimedStat.isFile() ||
    claimedStat.isSymbolicLink() ||
    claimedStat.nlink !== 1
  )
    throw new Error("claimed artifact is unsafe");
  return claimed;
}

function acquireLock(operationRoot = OPERATION_ROOT) {
  const lockPath = path.join(operationRoot, "operation.lock");
  fs.mkdirSync(operationRoot, { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid = 0;
    try {
      pid = Number(fs.readFileSync(lockPath, "utf8").trim());
    } catch {
      /* stale lock */
    }
    try {
      process.kill(pid, 0);
      throw new Error("another release installation is active");
    } catch (probeError) {
      if (probeError.message === "another release installation is active") throw probeError;
      fs.unlinkSync(lockPath);
      acquireLock(operationRoot);
    }
  }
}
function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function runSystemctl(command, unit) {
  return new Promise((resolve, reject) =>
    execFile("systemctl", [command, unit], { shell: false, timeout: 5_000 }, (error) =>
      error ? reject(new Error("production service control failed")) : resolve()
    )
  );
}
function removeGate() {
  try {
    fs.unlinkSync(GATE_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function createGate() {
  fs.mkdirSync(path.dirname(GATE_PATH), { recursive: true, mode: 0o755 });
  if (!fs.existsSync(GATE_PATH))
    fs.writeFileSync(GATE_PATH, "allowed\n", { flag: "wx", mode: 0o644 });
}
function serviceController() {
  return {
    enable: async () => {
      await runSystemctl("enable", RECOVERY_UNIT);
      await runSystemctl("enable", PRODUCTION_UNIT);
    },
    preparePromotion: async () => {
      removeGate();
      await runSystemctl("stop", PRODUCTION_UNIT);
    },
    restart: async () => {
      createGate();
      await runSystemctl("restart", PRODUCTION_UNIT);
    },
    stop: async () => {
      removeGate();
      await runSystemctl("stop", PRODUCTION_UNIT);
    },
    disable: async () => {
      removeGate();
      await runSystemctl("stop", PRODUCTION_UNIT);
    },
  };
}
function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const data = JSON.stringify(body);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => resolve({ statusCode: response.statusCode, body: raw }));
      }
    );
    request.setTimeout(3_000, () => request.destroy());
    request.on("error", reject);
    request.end(data);
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.get(
      { hostname: target.hostname, port: target.port, path: target.pathname },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => resolve({ statusCode: response.statusCode, body: raw }));
      }
    );
    request.setTimeout(3_000, () => request.destroy());
    request.on("error", reject);
  });
}
function systemctlIsActive(unit, exec = execFile) {
  return new Promise((resolve, reject) => {
    exec("systemctl", ["is-active", unit], { shell: false, timeout: 5_000 }, (error, stdout) => {
      if (error) return reject(new Error("production service is not active"));
      resolve(String(stdout || "").trim() === "active");
    });
  });
}
async function verifyProductionActivation(
  { version, releaseDir },
  deps = {}
) {
  const fileSystem = deps.fs || fs;
  const pathModule = deps.path || path;
  const requestStatus = deps.getJson || getJson;
  const isServiceActive =
    deps.isServiceActive || ((unit) => systemctlIsActive(unit, deps.execFile || execFile));

  const currentStat = fileSystem.lstatSync(CURRENT_LINK);
  if (!currentStat.isSymbolicLink()) throw new Error("current release is not a symlink");
  const currentTarget = pathModule.resolve(
    pathModule.dirname(CURRENT_LINK),
    fileSystem.readlinkSync(CURRENT_LINK)
  );
  if (currentTarget !== pathModule.resolve(releaseDir))
    throw new Error("current release target does not match activation");
  if (pathModule.basename(pathModule.resolve(releaseDir)) !== version)
    throw new Error("active release version does not match activation");

  const gateStat = fileSystem.lstatSync(GATE_PATH);
  if (!gateStat.isFile() || gateStat.isSymbolicLink())
    throw new Error("production gate is invalid");
  if (!(await isServiceActive(PRODUCTION_UNIT)))
    throw new Error("production service is not active");

  const response = await requestStatus(`http://127.0.0.1:${PRODUCTION_PORT}/api/status`);
  let status;
  try {
    status = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
  } catch {
    throw new Error("production status response is invalid");
  }
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    !status ||
    status.service !== "multimedica-production" ||
    status.ok !== true ||
    status.state !== "healthy"
  )
    throw new Error("production status is not healthy");
  return { ok: true };
}
async function verifySyntheticState() {
  const stateId = `candidate-${crypto.randomUUID()}`;
  const response = await postJson("http://127.0.0.1:3000/api/runtime-state", {
    kind: "room",
    state_id: stateId,
    priority: "room",
    display: { mode: "room_status", status: { code: "available", label: "CANDIDATE" } },
  });
  if (response.statusCode < 200 || response.statusCode >= 300)
    throw new Error("controller rejected candidate state");
  const display = await getJson("http://127.0.0.1:3001/api/state");
  if (!display.body.includes(stateId)) throw new Error("candidate display state was not observed");
}
function readYes(inputStream = process.stdin, outputStream = process.stdout) {
  return new Promise((resolve, reject) => {
    outputStream.write(
      "Confirm the physical display showed the CANDIDATE state. Type lowercase yes to continue:\n"
    );
    const input = readline.createInterface({ input: inputStream, terminal: false });
    let settled = false;
    input.once("line", (line) => {
      settled = true;
      input.close();
      if (line === "yes") resolve();
      else reject(new Error("operator confirmation was not lowercase yes"));
    });
    input.once("close", () => {
      if (typeof inputStream.pause === "function") inputStream.pause();
      if (typeof inputStream.unref === "function") inputStream.unref();
      if (!settled) reject(new Error("operator session ended before authorization"));
    });
  });
}
async function runOperation(options, deps = {}) {
  const lock = deps.acquireLock || acquireLock;
  const unlock = deps.releaseLock || releaseLock;
  const claim = deps.claimArtifact || claimArtifact;
  const managerFactory = deps.createReleaseManager || createReleaseManager;
  const controllerFactory = deps.serviceController || serviceController;
  const available = deps.portAvailable || portAvailable;
  const syntheticState = deps.verifySyntheticState || verifySyntheticState;
  const confirmation = deps.readYes || readYes;
  const activationVerifier = deps.verifyProductionActivation || verifyProductionActivation;
  const fileSystem = deps.fs || fs;
  lock(deps.operationRoot);
  let claimed;
  let authorized = false;
  let manager;
  let staged;
  try {
    claimed = claim(options.artifactName, deps.transferRoot, deps.operationRoot);
    process.stdout.write("ARTIFACT_CLAIMED\n");
    const claimedHash = crypto.createHash("sha256").update(fs.readFileSync(claimed)).digest("hex");
    if (claimedHash !== options.expectedSha256) throw new Error("claimed artifact hash mismatch");
    const productionBefore = await available(PRODUCTION_PORT);
    const controller =
      typeof controllerFactory === "function" ? controllerFactory() : controllerFactory;
    manager = managerFactory({
      roots: { stateRoot: STATE_ROOT, releaseRoot: RELEASE_ROOT, currentLink: CURRENT_LINK },
      serviceController: controller,
      preparePromotion: controller.preparePromotion,
      postPromotionVerifier: activationVerifier,
      rollbackVerifier: activationVerifier,
    });
    staged = await manager.stageArtifact({
      artifactPath: claimed,
      expectedSha256: options.expectedSha256,
      version: options.version,
    });
    await manager.startCandidate(staged.transactionId);
    if ((await available(PRODUCTION_PORT)) !== productionBefore)
      throw new Error("production port changed during candidate validation");
    await syntheticState();
    await confirmation();
    authorized = true;
    await manager.promoteCandidate(staged.transactionId);
    process.stdout.write("INSTALL_RELEASE_COMPLETE\n");
  } catch (error) {
    if (!authorized && staged) {
      try {
        await manager.abandonStaging(staged.transactionId);
      } catch {
        /* bounded cleanup */
      }
    }
    throw new Error("release installation failed");
  } finally {
    if (claimed) {
      try {
        fileSystem.unlinkSync(claimed);
      } catch {
        /* bounded cleanup */
      }
    }
    unlock(deps.operationRoot);
  }
}
if (require.main === module) {
  try {
    runOperation(parseArgs(process.argv.slice(2))).catch(() => {
      process.stderr.write("release installation failed\n");
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
module.exports = {
  parseArgs,
  claimArtifact,
  acquireLock,
  runOperation,
  serviceController,
  readYes,
  verifyProductionActivation,
};
