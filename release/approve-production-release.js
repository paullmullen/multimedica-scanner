"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

function prepareApprovedRelease({ rootDir, version, approvedAt = new Date().toISOString() }) {
  if (!VERSION_PATTERN.test(String(version || ""))) {
    throw new Error("version must use numeric semantic versioning, for example 1.0.5");
  }

  const outputDir = path.join(rootDir, "release-output");
  const artifact = `multimedica-production-${version}.tgz`;
  const checksum = `${artifact}.sha256`;
  const buildMetadata = `multimedica-production-${version}.build.json`;
  const artifactPath = path.join(outputDir, artifact);
  const checksumPath = path.join(outputDir, checksum);
  const buildPath = path.join(outputDir, buildMetadata);

  requireFile(artifactPath, "production artifact");
  requireFile(checksumPath, "checksum sidecar");
  requireFile(buildPath, "build metadata");

  const sidecarHash = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0].toLowerCase();
  if (!HASH_PATTERN.test(sidecarHash)) throw new Error("checksum sidecar is malformed");

  const artifactHash = sha256File(artifactPath);
  if (artifactHash !== sidecarHash) throw new Error("artifact SHA-256 does not match sidecar");

  let build;
  try {
    build = JSON.parse(fs.readFileSync(buildPath, "utf8"));
  } catch {
    throw new Error("build metadata is not valid JSON");
  }
  if (build.version !== undefined && build.version !== version) {
    throw new Error("build metadata version does not match requested version");
  }

  return {
    schema_version: 1,
    version,
    artifact,
    sha256: artifactHash,
    build_metadata: buildMetadata,
    approved_at: approvedAt,
  };
}

function approveProductionRelease(options) {
  const pointer = prepareApprovedRelease(options);
  const outputPath = path.join(options.rootDir, "release-output", "approved-production-release.json");
  const temporaryPath = `${outputPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, outputPath);
  return { outputPath, pointer };
}

if (require.main === module) {
  try {
    const version = process.argv[2];
    const rootDir = path.resolve(__dirname, "..");
    const result = approveProductionRelease({ rootDir, version });
    process.stdout.write(`${result.outputPath}\n${result.pointer.version}\n${result.pointer.sha256}\n`);
  } catch (error) {
    process.stderr.write(`APPROVAL_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { approveProductionRelease, prepareApprovedRelease, sha256File };
