"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  ALLOWLIST,
  FORMAT_VERSION,
  RELEASE_NAME,
  SEMVER,
  sha256,
  stableJson,
  canonicalize,
  assertSafePath,
  readAllowedFiles,
  createManifest,
  writeOctal,
  tarHeader,
  createDeterministicTgz,
  readTgz,
  validateArtifact,
  validateManifest,
} = require("../bootstrap/lib/release-artifact");

function gitCommit(sourceDir) {
  try {
    return execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function buildRelease({ sourceDir, outputDir, version, builtAt, commit }) {
  if (!SEMVER.test(version || "")) throw new Error("version must be semantic");
  const files = readAllowedFiles(sourceDir);
  const metadata = {
    builtAt: builtAt || new Date(Number(process.env.SOURCE_DATE_EPOCH || 0) * 1000).toISOString(),
    commit: commit === undefined ? gitCommit(sourceDir) : commit,
  };
  const manifest = createManifest(version, files, metadata);
  validateManifest(manifest);
  const tgz = createDeterministicTgz([
    { path: "manifest.json", content: Buffer.from(stableJson(manifest)) },
    ...files,
  ]);
  const hash = sha256(tgz);
  validateArtifact(tgz, hash);
  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = `${RELEASE_NAME}-${version}`;
  const artifactPath = path.join(outputDir, `${baseName}.tgz`);
  const hashPath = path.join(outputDir, `${baseName}.tgz.sha256`);
  const reportPath = path.join(outputDir, `${baseName}.build.json`);
  fs.writeFileSync(artifactPath, tgz);
  fs.writeFileSync(hashPath, `${hash}  ${path.basename(artifactPath)}\n`, "utf8");
  fs.writeFileSync(
    reportPath,
    stableJson({
      artifact: path.basename(artifactPath),
      sha256: hash,
      manifest,
      files: manifest.files,
    })
  );
  return { artifactPath, hashPath, reportPath, sha256: hash, manifest };
}

if (require.main === module) {
  const [version, outputDir = path.join(process.cwd(), "release-output")] = process.argv.slice(2);
  try {
    const result = buildRelease({ sourceDir: process.cwd(), outputDir, version });
    process.stdout.write(`${result.artifactPath}\n${result.sha256}\n`);
  } catch (error) {
    process.stderr.write(`release build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWLIST,
  FORMAT_VERSION,
  RELEASE_NAME,
  SEMVER,
  sha256,
  stableJson,
  canonicalize,
  assertSafePath,
  readAllowedFiles,
  createManifest,
  writeOctal,
  tarHeader,
  createDeterministicTgz,
  readTgz,
  validateArtifact,
  validateManifest,
  gitCommit,
  buildRelease,
};
