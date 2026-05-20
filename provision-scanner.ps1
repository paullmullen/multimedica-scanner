param(
    [string]$PiHost = "multimedica_edge@multimedicascanner1.local",
    [string]$LocalProjectDir = ".",
    [string]$LocalEnvFile = ".env",
    [string]$RemoteTempDir = "/home/multimedica_edge/provisioning",
    [switch]$SkipEnv,
    [switch]$InstallBasePackages,
    [switch]$InstallSudoersPolicy
)

$ErrorActionPreference = "Stop"

function log($msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] ==> $msg"
}

function Invoke-Checked {
    param(
        [string]$Description,
        [string]$Exe,
        [string[]]$CommandArgs,
        [switch]$AllowFailure
    )

    if ($Description) { log $Description }

    Write-Host "    $Exe $($CommandArgs -join ' ')" -ForegroundColor DarkGray
    & $Exe @CommandArgs
    $exitCode = $LASTEXITCODE

    if ((-not $AllowFailure) -and ($exitCode -ne 0)) {
        throw "Command failed with exit code ${exitCode}: $Description"
    }

    return $exitCode
}

$SshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $SshCommand) { $SshCommand = Get-Command ssh -ErrorAction SilentlyContinue }
if (-not $SshCommand) { throw "ssh not found." }
$SshExe = $SshCommand.Source

$ScpCommand = Get-Command scp.exe -ErrorAction SilentlyContinue
if (-not $ScpCommand) { $ScpCommand = Get-Command scp -ErrorAction SilentlyContinue }
if (-not $ScpCommand) { throw "scp not found." }
$ScpExe = $ScpCommand.Source

Write-Host "Using SSH: $SshExe" -ForegroundColor DarkGray
Write-Host "Using SCP: $ScpExe" -ForegroundColor DarkGray

# First-time scanner setup note:
# - StrictHostKeyChecking=accept-new automatically trusts a brand-new Pi host key.
# - If the host key changes later, SSH will still stop and warn rather than silently trusting it.
# - The sudoers install step may still ask once for the Pi password on a fresh device.
$SshCommonArgs = @(
    "-o", "StrictHostKeyChecking=accept-new"
)

Write-Host ""
Write-Host "First-time connection note:" -ForegroundColor Yellow
Write-Host "  SSH will automatically trust a brand-new scanner host key."
Write-Host "  If this Pi was re-imaged and SSH warns about a changed host key, stop and verify the device."
Write-Host "  You may be prompted once for the Pi password while the sudoers policy is installed."
Write-Host ""

function Invoke-Remote {
    param(
        [string]$Description,
        [string]$RemoteCommand,
        [switch]$Tty,
        [switch]$AllowFailure
    )

    $args = @()
    $args += $SshCommonArgs
    if ($Tty) { $args += "-tt" }
    $args += $PiHost
    $args += $RemoteCommand

    Invoke-Checked -Description $Description -Exe $SshExe -CommandArgs $args -AllowFailure:$AllowFailure | Out-Null
}

function Copy-Remote {
    param(
        [string]$Description,
        [string[]]$ScpArgs
    )

    $args = @()
    $args += $SshCommonArgs
    $args += $ScpArgs

    Invoke-Checked -Description $Description -Exe $ScpExe -CommandArgs $args | Out-Null
}

Write-Host "Provisioning scanner on $PiHost ..." -ForegroundColor Cyan

$LocalProjectDir = (Resolve-Path $LocalProjectDir).Path

$InstallerPath = Join-Path $LocalProjectDir "provision/install-scanner.sh"
$SystemdDir = Join-Path $LocalProjectDir "provision/systemd"

if (-not (Test-Path $InstallerPath)) {
    throw "Installer not found: $InstallerPath"
}

$ResolvedEnvPath = $null

if (-not $SkipEnv) {
    if (-not (Test-Path $LocalEnvFile)) {
        throw ".env not found. Use -SkipEnv if needed."
    }

    $ResolvedEnvPath = (Resolve-Path $LocalEnvFile).Path
}

# Start from a clean remote staging directory.
Invoke-Remote "Creating remote temp directory..." "rm -rf $RemoteTempDir && mkdir -p $RemoteTempDir"


# =========================
# Install appliance sudoers policy
# =========================
if ($InstallSudoersPolicy) {

    $SudoersPolicy = @'
# Multimedica scanner appliance provisioning/admin policy
# Managed by provision-scanner.ps1
multimedica_edge ALL=(ALL) NOPASSWD:ALL
'@

    $LocalSudoersPolicy = Join-Path $env:TEMP "multimedica-scanner-sudoers"

    try {
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText(
            $LocalSudoersPolicy,
            $SudoersPolicy.Replace("`r`n", "`n"),
            $Utf8NoBom
        )
    } catch {
        Set-Content -Path $LocalSudoersPolicy -Value $SudoersPolicy -Encoding UTF8
    }

    Copy-Remote `
        "Copying appliance sudoers policy ..." `
        @($LocalSudoersPolicy, "${PiHost}:${RemoteTempDir}/multimedica-scanner-sudoers")

    Invoke-Remote `
        "Installing appliance sudoers policy ..." `
        "echo 'Installing sudoers policy. This step may ask for the Pi password once.' && sudo -v && sudo install -o root -g root -m 0440 $RemoteTempDir/multimedica-scanner-sudoers /etc/sudoers.d/multimedica-scanner && sudo visudo -cf /etc/sudoers.d/multimedica-scanner" `
        -Tty

} else {

    Write-Host "Skipping appliance sudoers policy install. Use -InstallSudoersPolicy to run it."

    Invoke-Remote `
        "Verifying passwordless sudo is available ..." `
        "sudo -n true || { echo 'Passwordless sudo is not available. Re-run with -InstallSudoersPolicy.'; exit 1; }"
}


# =========================
# Prepare fresh Raspberry Pi OS
# =========================
if ($InstallBasePackages) {
    $BasePackageScript = @'
#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "==> Updating package lists"
apt-get update

echo "==> Installing base packages needed by scanner/kiosk"
apt-get install -y \
  nodejs \
  npm \
  git \
  curl \
  jq \
  evtest \
  network-manager \
  xserver-xorg \
  xinit \
  openbox \
  unclutter \
  x11-xserver-utils

echo "==> Installing Chromium if needed"
if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  apt-get install -y chromium-browser || apt-get install -y chromium
fi

echo "==> Verifying Node/npm"
node -v
npm -v

echo "==> Base package installation complete"
'@

    $LocalBasePackageScript = Join-Path $env:TEMP "multimedica-install-base-packages.sh"

    # Use UTF8 without BOM where supported; fall back safely for older Windows PowerShell.
    try {
        $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($LocalBasePackageScript, $BasePackageScript.Replace("`r`n", "`n"), $Utf8NoBom)
    } catch {
        Set-Content -Path $LocalBasePackageScript -Value $BasePackageScript -Encoding UTF8
    }

    Copy-Remote "Copying base package installer..." @($LocalBasePackageScript, "${PiHost}:${RemoteTempDir}/install-base-packages.sh")
    Invoke-Remote "Running base package installer..." "chmod +x $RemoteTempDir/install-base-packages.sh && sudo bash $RemoteTempDir/install-base-packages.sh"
} else {
    log "Skipping base package installation because -InstallBasePackages was not specified."
}

$FilesToCopy = @(
    "scanner.js",
    "configQr.js",
    "package.json",
    "package-lock.json"
)

foreach ($RelativePath in $FilesToCopy) {
    $FullPath = Join-Path $LocalProjectDir $RelativePath
    if (-not (Test-Path $FullPath)) {
        throw "Required file not found: $FullPath"
    }

    Copy-Remote "Copying $RelativePath ..." @($FullPath, "${PiHost}:${RemoteTempDir}/")
}

$OptionalDirs = @(
    "kiosk",
    "display"
)

foreach ($RelativePath in $OptionalDirs) {
    $FullPath = Join-Path $LocalProjectDir $RelativePath

    if (Test-Path $FullPath) {
        Copy-Remote "Copying $RelativePath ..." @("-r", "$FullPath", "${PiHost}:${RemoteTempDir}/")
    } else {
        Write-Host "Skipping optional directory not found: $RelativePath" -ForegroundColor Yellow
    }
}

# Historical note:
# The local repo folder is named "display", but the runtime folder on the Pi is "kiosk-display".
Invoke-Remote "Preparing kiosk-display directory..." "if [ -d $RemoteTempDir/display ]; then mv $RemoteTempDir/display $RemoteTempDir/kiosk-display; fi"

Copy-Remote "Copying installer..." @("$InstallerPath", "${PiHost}:${RemoteTempDir}/install-scanner.sh")

if (Test-Path $SystemdDir) {
    Copy-Remote "Copying systemd files..." @("-r", "$SystemdDir", "${PiHost}:${RemoteTempDir}/")
} else {
    Write-Host "Skipping systemd directory not found: $SystemdDir" -ForegroundColor Yellow
}

# Generate the kiosk login profile instead of relying on a local dotfile.
# This prevents a malformed local .bash_profile from breaking kiosk startup on a fresh Pi.
$KioskBashProfile = @'
if [[ -z "$DISPLAY" && -z "$SSH_CONNECTION" && "$(tty)" == "/dev/tty1" ]]; then
  echo "Starting kiosk at $(date)" >> /home/multimedica_edge/kiosk.log
  startx /opt/multimedica-scanner/kiosk/start-kiosk.sh -- >> /home/multimedica_edge/kiosk.log 2>&1
fi
'@

$LocalBashProfile = Join-Path $env:TEMP "multimedica-kiosk-bash-profile"
try {
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LocalBashProfile, $KioskBashProfile.Replace("`r`n", "`n"), $Utf8NoBom)
} catch {
    Set-Content -Path $LocalBashProfile -Value $KioskBashProfile -Encoding UTF8
}

Copy-Remote "Copying generated .bash_profile ..." @("$LocalBashProfile", "${PiHost}:${RemoteTempDir}/.bash_profile")

if (-not $SkipEnv) {
    Copy-Remote "Copying .env ..." @("$ResolvedEnvPath", "${PiHost}:${RemoteTempDir}/.env")
} else {
    Write-Host "Skipping .env copy because -SkipEnv was specified." -ForegroundColor Yellow
}

Invoke-Remote "Setting remote permissions..." "find $RemoteTempDir -type f -name '*.sh' -exec sed -i 's/\r$//' {} \; && chmod +x $RemoteTempDir/install-scanner.sh && find $RemoteTempDir -type f -name '*.sh' -exec chmod +x {} \;"
# Installer uses sudo internally and may prompt once for password.
Invoke-Remote "Running installer..." "sudo $RemoteTempDir/install-scanner.sh $RemoteTempDir"

# Configure tty1 console autologin so .bash_profile actually runs at boot.
# Without this, the Pi stops at a console login prompt and the kiosk never starts.
$AutologinConf = @'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin multimedica_edge --noclear %I $TERM
'@

$LocalAutologinConf = Join-Path $env:TEMP "multimedica-getty-autologin.conf"
try {
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LocalAutologinConf, $AutologinConf.Replace("`r`n", "`n"), $Utf8NoBom)
} catch {
    Set-Content -Path $LocalAutologinConf -Value $AutologinConf -Encoding UTF8
}

Copy-Remote "Copying tty1 autologin config ..." @("$LocalAutologinConf", "${PiHost}:${RemoteTempDir}/autologin.conf")
Invoke-Remote "Installing tty1 autologin config ..." "sudo mkdir -p /etc/systemd/system/getty@tty1.service.d && sudo cp $RemoteTempDir/autologin.conf /etc/systemd/system/getty@tty1.service.d/autologin.conf && sudo systemctl daemon-reload"

Write-Host ""
Write-Host "Provisioning finished. Checking services..." -ForegroundColor Cyan

Invoke-Remote "Checking scanner service..." "sudo systemctl --no-pager --full status multimedica-scanner.service" -Tty -AllowFailure
Invoke-Remote "Checking kiosk display service..." "sudo systemctl --no-pager --full status kiosk-display.service" -Tty -AllowFailure
Invoke-Remote "Recent scanner logs..." "journalctl -u multimedica-scanner.service -n 40 --no-pager" -Tty -AllowFailure
Invoke-Remote "Recent kiosk display logs..." "journalctl -u kiosk-display.service -n 40 --no-pager" -Tty -AllowFailure

Write-Host ""
Write-Host "Provisioning complete." -ForegroundColor Green
