# Multimédica Production Release Publication Procedure

**Audience:** Qualified developer or production release owner

**Purpose:** Build, approve, store, and publish updated everyday scanner runtime software

**Repository:** <https://github.com/paullmullen/multimedica-scanner>

**Related installer procedure:** [Scanner Appliance Installation Guide](installation.md)

---

## 1. What this procedure does

The scanner's everyday runtime is a Node.js application. It is not compiled into a single executable. Instead, the release tooling packages an approved source revision into a versioned archive and produces the records needed to verify and deploy that exact archive.

For a version such as `1.0.5`, the completed release set contains four files:

```text
release-output/approved-production-release.json
release-output/multimedica-production-1.0.5.tgz
release-output/multimedica-production-1.0.5.tgz.sha256
release-output/multimedica-production-1.0.5.build.json
```

- The `.tgz` file contains the deployable production software.
- The `.tgz.sha256` sidecar records the archive's SHA-256 digital fingerprint.
- The `.build.json` file records build details.
- `approved-production-release.json` tells the installer which committed release is approved.

These files are intentionally stored in Git with the approved source revision. That allows the installation procedure to retrieve and validate the exact package authorized for deployment without asking the field installer to choose a version.

---

## 2. Release rules

1. Use a new numeric semantic version for every distinct production artifact.
2. Never replace or rebuild an existing version with different contents.
3. Build only from reviewed source with a clean Git working tree.
4. Run the full automated test suite before building.
5. Commit the archive, checksum, build record, and approval record together.
6. Test the release on a scanner appliance before declaring it operationally accepted.

Semantic-version guidance:

- **Patch**, such as `1.0.4` to `1.0.5`: compatible bug fix or small runtime improvement.
- **Minor**, such as `1.0.5` to `1.1.0`: compatible new runtime capability.
- **Major**, such as `1.1.0` to `2.0.0`: intentionally incompatible operational or contract change.

Version numbers are assigned deliberately by the release owner; they are not incremented automatically.

---

## 3. Prepare the approved source revision

Complete development and review first. Commit the approved source and test changes before building the release. Do not build from uncommitted edits.

From **Windows PowerShell** in the repository root:

```powershell
git switch main
git pull --ff-only origin main
git status --short
git log -1 --oneline
```

`git status --short` must produce no output. If it lists any file, stop and resolve or commit the source changes before building.

Install the repository's locked dependencies:

**Windows PowerShell:**

```powershell
npm ci
```

---

## 4. Run the complete automated test suite

**Windows PowerShell:**

```powershell
npx --no-install jest --runInBand
git diff --check
```

All test suites and tests must pass. `git diff --check` must report no errors. Do not publish a release from a failed or interrupted test run.

If the release changes an operational workflow or physical display, complete the relevant manual acceptance checks before approval as well.

---

## 5. Select and reserve the new version

Enter the new version and confirm that none of its release files already exists.

**Windows PowerShell:**

```powershell
$newReleaseVersion = Read-Host "Enter the new production version, for example 1.0.5"

$newReleaseFiles = @(
  ".\release-output\multimedica-production-$newReleaseVersion.tgz",
  ".\release-output\multimedica-production-$newReleaseVersion.tgz.sha256",
  ".\release-output\multimedica-production-$newReleaseVersion.build.json"
)

foreach ($file in $newReleaseFiles) {
  if (Test-Path $file) { throw "Release version already exists; choose a new version: $file" }
}
```

Do not delete an older release merely to reuse its number.

---

## 6. Build the production release

This is the command that packages the runtime application:

**Windows PowerShell:**

```powershell
npm run build:production-release -- $newReleaseVersion .\release-output
```

The command must create:

```text
multimedica-production-<version>.tgz
multimedica-production-<version>.tgz.sha256
multimedica-production-<version>.build.json
```

Confirm all three files exist:

**Windows PowerShell:**

```powershell
$artifactFile = ".\release-output\multimedica-production-$newReleaseVersion.tgz"
$checksumFile = "$artifactFile.sha256"
$buildFile = ".\release-output\multimedica-production-$newReleaseVersion.build.json"

Get-Item $artifactFile, $checksumFile, $buildFile
```

---

## 7. Approve the exact release package

The approval command independently verifies the archive against its checksum sidecar and then updates the repository's approved-release record.

**Windows PowerShell:**

```powershell
node .\release\approve-production-release.js $newReleaseVersion
Get-Content .\release-output\approved-production-release.json
```

The approval record must name the new version and the three newly generated files. If the command reports `APPROVAL_FAILED`, stop and correct the release set rather than editing the approval JSON manually.

---

## 8. Validate the approved release contract

**Windows PowerShell:**

```powershell
npx --no-install jest `
  --runTestsByPath `
  .\tests\approved-production-release.test.js `
  --runInBand

$artifactSha = (Get-FileHash $artifactFile -Algorithm SHA256).Hash.ToLowerInvariant()
$sidecarSha = ((Get-Content $checksumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$approvedRelease = Get-Content .\release-output\approved-production-release.json -Raw | ConvertFrom-Json
$approvedSha = ([string]$approvedRelease.sha256).ToLowerInvariant()

"Calculated SHA-256: $artifactSha"
"Sidecar SHA-256:    $sidecarSha"
"Approved SHA-256:   $approvedSha"

if (($artifactSha -ne $sidecarSha) -or ($artifactSha -ne $approvedSha)) {
  throw "Release SHA-256 values do not match."
}
```

The focused test must pass and all three displayed SHA-256 values must be identical.

---

## 9. Commit the complete release set

Stage all four release files together:

**Windows PowerShell:**

```powershell
git add `
  ".\release-output\multimedica-production-$newReleaseVersion.tgz" `
  ".\release-output\multimedica-production-$newReleaseVersion.tgz.sha256" `
  ".\release-output\multimedica-production-$newReleaseVersion.build.json" `
  .\release-output\approved-production-release.json

git diff --cached --check
git status --short
```

Expected staged files are the new `.tgz`, `.tgz.sha256`, `.build.json`, and the updated `approved-production-release.json`. Investigate any unexpected file before committing.

Commit and push:

**Windows PowerShell:**

```powershell
git commit -m "Add production release $newReleaseVersion"
git push origin main
git status --short
git log -2 --oneline
```

The final `git status --short` must produce no output.

---

## 10. Validate deployment on a scanner appliance

Follow Section 16.3 of the [Scanner Appliance Installation Guide](installation.md) to install the newly published release on a controlled scanner appliance.

Require:

- physical `CANDIDATO` confirmation;
- `RESULT: PASS` from `-InstallRelease`;
- `RESULT: PASS` from the subsequent `-Verify` operation;
- correct daily clinic display;
- successful test-patient barcode workflow; and
- successful controlled power-cycle recovery.

Only after those checks pass should the release be treated as operationally accepted for broader deployment.

---

## 11. Release completion checklist

- [ ] Source and tests were reviewed and committed before the build
- [ ] Git working tree was clean
- [ ] Full Jest suite passed
- [ ] A new version number was used
- [ ] Build command completed successfully
- [ ] `.tgz`, `.tgz.sha256`, and `.build.json` were generated
- [ ] Approval command completed successfully
- [ ] Approved-release contract test passed
- [ ] All three SHA-256 values matched
- [ ] Four release files were committed together
- [ ] Release commit was pushed to `main`
- [ ] Controlled scanner deployment passed
- [ ] Physical and scan acceptance checks passed
- [ ] Controlled power-cycle recovery passed
