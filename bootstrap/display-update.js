"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ASSETS = Object.freeze(["app.js", "full_logo.png", "index.html", "styles.css"]);
const TARGET = "/opt/multimedica-scanner/bootstrap/public";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function validateBundle(source, fileSystem = fs) {
  const manifestPath = path.join(source, "manifest.json");
  const manifestStat = fileSystem.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("display manifest is unsafe");
  const manifest = JSON.parse(fileSystem.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("display manifest is invalid");
  const names = manifest.files.map((item) => item && item.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(ASSETS)) throw new Error("display manifest allowlist mismatch");
  for (const item of manifest.files) {
    if (!/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 1)
      throw new Error("display manifest metadata is invalid");
    const file = path.join(source, item.name);
    const stat = fileSystem.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("display asset is unsafe");
    if (stat.size !== item.size || sha256(file) !== item.sha256) throw new Error("display asset integrity failed");
  }
  return manifest;
}

function copyBundle(source, destination) {
  fs.mkdirSync(destination, { mode: 0o755 });
  for (const name of ASSETS) {
    const target = path.join(destination, name);
    fs.copyFileSync(path.join(source, name), target, fs.constants.COPYFILE_EXCL);
    fs.chownSync(target, 0, 0);
    fs.chmodSync(target, 0o644);
  }
  fs.chownSync(destination, 0, 0);
  fs.chmodSync(destination, 0o755);
}

function systemctl(command, unit) {
  const result = spawnSync("systemctl", [command, unit], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error("display service control failed");
}

function curl(pathname) {
  const result = spawnSync("curl", ["-fsS", `http://127.0.0.1:3001${pathname}`], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error("display verification failed");
  return result.stdout;
}

function defaultServices() {
  return {
    restart: () => {
      systemctl("restart", "multimedica-display.service");
      systemctl("restart", "multimedica-kiosk.service");
    },
    verify: () => {
      systemctl("is-active", "multimedica-display.service");
      systemctl("is-active", "multimedica-kiosk.service");
      const health = JSON.parse(curl("/api/health"));
      if (!health.ok || health.service !== "multimedica-display") throw new Error("display health failed");
      if (!curl("/").includes('id="commissioning-screen"')) throw new Error("display marker missing");
      if (!curl("/app.js").includes("runtimeView")) throw new Error("display client marker missing");
      if (curl("/full_logo.png").length < 100) throw new Error("display logo missing");
    },
  };
}

async function installDisplayBundle(source, deps = {}) {
  const target = deps.target || TARGET;
  const services = deps.services || defaultServices();
  validateBundle(source);
  const targetStat = fs.lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error("display target is unsafe");
  const parent = path.dirname(target);
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const staged = path.join(parent, `.public-update-${token}`);
  const backup = path.join(parent, `.public-backup-${token}`);
  const failed = path.join(parent, `.public-failed-${token}`);
  let switched = false;
  try {
    copyBundle(source, staged);
    fs.renameSync(target, backup);
    fs.renameSync(staged, target);
    switched = true;
    await services.restart();
    await services.verify();
    fs.rmSync(backup, { recursive: true, force: true });
    return { ok: true, rolledBack: false };
  } catch (error) {
    if (switched) {
      try {
        fs.renameSync(target, failed);
        fs.renameSync(backup, target);
        await services.restart();
        await services.verify();
        fs.rmSync(failed, { recursive: true, force: true });
        process.stdout.write("DISPLAY_UPDATE_ROLLED_BACK\n");
      } catch {
        throw new Error("display update rollback failed");
      }
    }
    throw new Error("display update failed");
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--source" || !path.isAbsolute(argv[1]))
    throw new Error("invalid display update arguments");
  return argv[1];
}

if (require.main === module) {
  try {
    installDisplayBundle(parseArgs(process.argv.slice(2)))
      .then(() => process.stdout.write("DISPLAY_UPDATE_COMPLETE\n"))
      .catch(() => { process.stderr.write("display update failed\n"); process.exitCode = 1; });
  } catch (error) {
    process.stderr.write("display update failed\n");
    process.exitCode = 1;
  }
}

module.exports = { ASSETS, TARGET, validateBundle, installDisplayBundle, parseArgs };
