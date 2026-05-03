param(
    [string]$PiHost = "multimedica_edge@multimedicascanner1.local",
    [string]$LocalProjectDir = ".",
    [string]$LocalEnvFile = ".env",
    [string]$RemoteTempDir = "/home/multimedica_edge/provisioning",
    [switch]$SkipEnv
)

function log($msg) {
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] ==> $msg"
}

$ErrorActionPreference = "Stop"

Write-Host "Provisioning scanner on $PiHost ..." -ForegroundColor Cyan

$scp = Get-Command scp -ErrorAction SilentlyContinue
$ssh = Get-Command ssh -ErrorAction SilentlyContinue

if (-not $scp) { throw "scp not found." }
if (-not $ssh) { throw "ssh not found." }

$LocalProjectDir = (Resolve-Path $LocalProjectDir).Path
$InstallerPath = Join-Path $LocalProjectDir "provision/install-scanner.sh"
$SystemdDir = Join-Path $LocalProjectDir "provision/systemd"

# Resolve .env if needed
$ResolvedEnvPath = $null
if (-not $SkipEnv) {
    if (-not (Test-Path $LocalEnvFile)) {
        throw ".env not found. Use -SkipEnv if needed."
    }
    $ResolvedEnvPath = (Resolve-Path $LocalEnvFile).Path
}

Write-Host "Creating remote temp directory..." -ForegroundColor Cyan
ssh $PiHost "rm -rf $RemoteTempDir && mkdir -p $RemoteTempDir"

function Copy-IfExists {
    param(
        [string]$RelativePath,
        [switch]$Recursive
    )

    $FullPath = Join-Path $LocalProjectDir $RelativePath
    if (-not (Test-Path $FullPath)) { return }

    Write-Host "Copying $RelativePath ..." -ForegroundColor Cyan

    if ($Recursive) {
        scp -r "$FullPath" "${PiHost}:${RemoteTempDir}/"
    } else {
        scp "$FullPath" "${PiHost}:${RemoteTempDir}/"
    }
}

# =========================
# Copy core files
# =========================
Copy-IfExists "scanner.js"
Copy-IfExists "configQr.js"
Copy-IfExists "package.json"
Copy-IfExists "package-lock.json"
Copy-IfExists "update-scanner.sh"

# =========================
# Copy directories
# =========================
Copy-IfExists "kiosk" -Recursive
Copy-IfExists "display" -Recursive

# Rename display → kiosk-display on remote
ssh $PiHost "if [ -d $RemoteTempDir/display ]; then mv $RemoteTempDir/display $RemoteTempDir/kiosk-display; fi"

# =========================
# Copy systemd + installer
# =========================
scp "$InstallerPath" "${PiHost}:${RemoteTempDir}/install-scanner.sh"

if (Test-Path $SystemdDir) {
    scp -r "$SystemdDir" "${PiHost}:${RemoteTempDir}/"
}

# =========================
# Copy .bash_profile (IMPORTANT)
# =========================
Copy-IfExists ".bash_profile"

# =========================
# Copy .env
# =========================
if (-not $SkipEnv) {
    Write-Host "Copying .env ..." -ForegroundColor Cyan
    scp "$ResolvedEnvPath" "${PiHost}:${RemoteTempDir}/.env"
}

# =========================
# Permissions
# =========================
ssh $PiHost "chmod +x $RemoteTempDir/install-scanner.sh"
ssh $PiHost "find $RemoteTempDir -type f -name '*.sh' -exec chmod +x {} \;"

# =========================
# Run installer
# =========================
Write-Host "Running installer..." -ForegroundColor Cyan
ssh -t $PiHost "sudo $RemoteTempDir/install-scanner.sh $RemoteTempDir"

# =========================
# Status check (clean)
# =========================
ssh -t $PiHost "sudo systemctl --no-pager --full status multimedica-scanner.service || true"
ssh -t $PiHost "sudo systemctl --no-pager --full status kiosk-display.service || true"

ssh -t $PiHost "journalctl -u multimedica-scanner.service -n 40 --no-pager || true"
ssh -t $PiHost "journalctl -u kiosk-display.service -n 40 --no-pager || true"

log "Restarting services"

sudo systemctl daemon-reload
sudo systemctl restart multimedica-scanner.service
sudo systemctl restart kiosk-display.service
sudo systemctl restart kiosk.service

sleep 3

log "Provisioning complete"

Write-Host "Provisioning complete." -ForegroundColor Green