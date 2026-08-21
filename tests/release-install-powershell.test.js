"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "provision-scanner.ps1");
const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(ROOT, "schemas", "provisioning-result.schema.json"), "utf8")
);
const HASH = "a".repeat(64);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mm-install-ps-"));
}

function writeFakeExecutables(root) {
  const sshLog = path.join(root, "ssh.log");
  const scpLog = path.join(root, "scp.log");
  const ssh = path.join(root, "ssh.cmd");
  const scp = path.join(root, "scp.cmd");
  fs.writeFileSync(
    ssh,
    [
      "@echo off",
      `>>"${sshLog}" echo %*`,
      'echo %* | findstr /C:" true" >nul',
      "if not errorlevel 1 exit /b 0",
      'echo %* | findstr /C:"sudo -n /usr/local/sbin/multimedica-release-install" >nul',
      "if errorlevel 1 exit /b 0",
      'if /I "%FAKE_SSH_MODE%"=="eof" exit /b 7',
      "echo ARTIFACT_CLAIMED",
      "echo Confirm the physical display showed the CANDIDATE state. Type lowercase yes to continue:",
      "set /p answer=",
      'if "%answer%"=="yes" (echo INSTALL_RELEASE_COMPLETE&exit /b 0)',
      "echo release installation failed 1>&2",
      "exit /b 7",
    ].join("\r\n")
  );
  fs.writeFileSync(
    scp,
    [
      "@echo off",
      `>>"${scpLog}" echo %*`,
      'if not "%FAKE_SCP_EXIT%"=="" exit /b %FAKE_SCP_EXIT%',
      "exit /b 0",
    ].join("\r\n")
  );
  return { ssh, scp, sshLog, scpLog };
}

function runInstall({
  artifactPath,
  artifactSha256,
  input = "yes\n",
  sshMode = "success",
  scpExit = "",
} = {}) {
  const root = tempDir();
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "multimedica_scanner_ed25519"), "fake-key");
  const fake = writeFakeExecutables(root);
  const resultFile = path.join(root, "provisioning-result.json");
  const artifact = artifactPath || path.join(root, "release.tgz");
  if (!artifactPath) fs.writeFileSync(artifact, "temporary artifact bytes");
  const expectedHash =
    artifactSha256 || crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SCRIPT,
      "-InstallRelease",
      "-PiHost",
      "multimedica_edge@fake-host",
      "-ReleaseVersion",
      "1.2.3",
      "-ArtifactPath",
      artifact,
      "-ArtifactSha256",
      expectedHash,
      "-ResultFile",
      resultFile,
    ],
    {
      cwd: root,
      input,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: {
        ...process.env,
        USERPROFILE: home,
        MULTIMEDICA_TEST_SSH_EXE: fake.ssh,
        MULTIMEDICA_TEST_SCP_EXE: fake.scp,
        FAKE_SSH_MODE: sshMode,
        FAKE_SCP_EXIT: scpExit,
      },
    }
  );
  const output = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null;
  const sshText = fs.existsSync(fake.sshLog) ? fs.readFileSync(fake.sshLog, "utf8") : "";
  const scpText = fs.existsSync(fake.scpLog) ? fs.readFileSync(fake.scpLog, "utf8") : "";
  return { root, result, output, sshText, scpText, artifact, fake };
}

function validateResult(result) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(SCHEMA);
  return { valid: validate(result), errors: validate.errors };
}

function executionEvidence(run) {
  return {
    status: run.result.status,
    signal: run.result.signal,
    error: run.result.error ? String(run.result.error) : null,
    stdout: run.result.stdout,
    stderr: run.result.stderr,
    output: run.output,
    schema: validateResult(run.output),
    sshText: run.sshText,
    scpText: run.scpText,
  };
}

function expectSchemaValid(run) {
  const evidence = executionEvidence(run);
  if (!evidence.schema.valid) {
    throw new Error(
      `Provisioning result failed schema validation:\n${JSON.stringify(evidence, null, 2)}`
    );
  }
}

function remove(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

describe("InstallRelease executable PowerShell workflow", () => {
  test("correct artifact reaches the fixed attached sudo wrapper and exact lowercase yes", () => {
    const run = runInstall();
    try {
      if (run.result.status !== 0) {
        throw new Error(
          `InstallRelease success path exited nonzero:\n${JSON.stringify(executionEvidence(run), null, 2)}`
        );
      }
      expect(run.sshText).toContain("sudo -n /usr/local/sbin/multimedica-release-install");
      expect(run.sshText).toContain("BatchMode=yes");
      expect(run.sshText).toContain("NumberOfPasswordPrompts=0");
      expect(run.sshText).not.toContain("systemctl");
      expect(run.sshText).not.toContain("/bin/sh");
      expect(run.sshText).not.toContain("node ");
      expect(run.sshText).toMatch(/--version\s+'1\.2\.3'/);
      expect(run.sshText).toContain("--sha256");
      expect(run.scpText).toMatch(
        /multimedica_edge@fake-host:.*\/release-transfer\/install-[a-f0-9]{32}\.tgz/
      );
      expectSchemaValid(run);
      expect(run.output.install_operation_status).toBe("complete");
      expect(JSON.stringify(run.output)).not.toMatch(
        /temporary artifact bytes|fake-secret|patient|barcode|PATH=|MULTIMEDICA_STATE_DIR/
      );
    } finally {
      remove(run.root);
    }
  });

  test("local SHA mismatch prevents SCP and attached SSH", () => {
    const run = runInstall({ artifactSha256: "b".repeat(64) });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.scpText).toBe("");
      expect(run.sshText).toBe("");
      expectSchemaValid(run);
    } finally {
      remove(run.root);
    }
  });

  test("SCP failure prevents the attached wrapper operation", () => {
    const run = runInstall({ scpExit: "9" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.scpText).not.toBe("");
      expect(run.sshText).toContain(" true");
      expect(run.sshText).not.toContain("sudo -n /usr/local/sbin/multimedica-release-install");
      expectSchemaValid(run);
    } finally {
      remove(run.root);
    }
  });

  test.each(["Yes\n", "y\n", "\n", "anything\n"])(
    "non-lowercase confirmation %j fails safely",
    (input) => {
      const run = runInstall({ input });
      try {
        expect(run.result.status).not.toBe(0);
        expect(run.sshText).toContain("sudo -n /usr/local/sbin/multimedica-release-install");
        expect(run.result.stdout).toContain("Operator confirmation must be exactly lowercase yes");
        expectSchemaValid(run);
        expect(JSON.stringify(run.output)).not.toMatch(
          /temporary artifact bytes|fake-secret|patient|barcode/
        );
      } finally {
        remove(run.root);
      }
    }
  );

  test("EOF/fake SSH failure propagates a bounded nonzero result", () => {
    const run = runInstall({ sshMode: "eof", input: "" });
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.sshText).toContain("sudo -n /usr/local/sbin/multimedica-release-install");
      expectSchemaValid(run);
      expect(JSON.stringify(run.output)).not.toMatch(
        /release installation failed 7|temporary artifact bytes/
      );
    } finally {
      remove(run.root);
    }
  });

  test("PowerShell AST parser accepts the installer source", () => {
    const parsed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'provision-scanner.ps1').Path, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { exit 1 }",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    expect(parsed.status).toBe(0);
  });

  test("display update mode is separate from release installation", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toContain("ParameterSetName = 'UpdateDisplay'");
    expect(source).toContain("Invoke-UpdateDisplay");
    expect(source).toContain("$script:LastRemoteOutput");
    expect(source).toContain("DISPLAY_UPDATE_ROLLED_BACK");
    expect(source).toContain("start-kiosk.sh");
    expect(source).toContain("DISPLAY_UPDATE_COMPLETE");
    expect(source).not.toMatch(/Invoke-UpdateDisplay[\s\S]*?multimedica-release-install/);
  });
});
