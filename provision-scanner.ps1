param(
    [string]$PiHost = "multimedica_edge@multimedicascanner1.local",
    [string]$LocalProjectDir = ".",
    [string]$LocalEnvFile = ".env",
    [string]$RemoteTempDir = "/home/multimedica_edge/provisioning",
    [switch]$SkipEnv
)

$ErrorActionPreference = "Stop"

Write-Host "Provisioning scanner on $PiHost ..." -ForegroundColor Cyan

$scp = Get-Command scp -ErrorAction SilentlyContinue
$ssh = Get-Command ssh -ErrorAction SilentlyContinue

if (-not $scp) {
    throw "scp not found. Install OpenSSH client on Windows or make sure it is in PATH."
}

if (-not $ssh) {
    throw "ssh not found. Install OpenSSH client on Windows or make sure it is in PATH."
}

$LocalProjectDir = (Resolve-Path $LocalProjectDir).Path
$InstallerPath = Join-Path $LocalProjectDir (Join-Path "provision" "install-scanner.sh")
$SystemdDir = Join-Path $LocalProjectDir (Join-Path "provision" "systemd")

if (-not (Test-Path $InstallerPath)) {
    throw "install-scanner.sh not found at: $InstallerPath"
}

$RequiredPaths = @(
    "scanner.js",
    "package.json"
)

foreach ($RelativePath in $RequiredPaths) {
    $FullPath = Join-Path $LocalProjectDir $RelativePath
    if (-not (Test-Path $FullPath)) {
        throw "Required path missing: $FullPath"
    }
}

$ResolvedEnvPath = $null
if (-not $SkipEnv) {
    if (-not (Test-Path $LocalEnvFile)) {
        throw ".env file not found at: $LocalEnvFile. Use -SkipEnv if you do not want to copy it."
    }
    $ResolvedEnvPath = (Resolve-Path $LocalEnvFile).Path
}

Write-Host "Local project: $LocalProjectDir" -ForegroundColor Yellow
Write-Host "Installer: $InstallerPath" -ForegroundColor Yellow
Write-Host "Remote temp dir: $RemoteTempDir" -ForegroundColor Yellow

Write-Host "Creating remote temp directory..." -ForegroundColor Cyan
ssh $PiHost "rm -rf $RemoteTempDir && mkdir -p $RemoteTempDir"

function Copy-IfExists {
    param(
        [string]$RelativePath,
        [switch]$Recursive
    )

    $FullPath = Join-Path $LocalProjectDir $RelativePath
    if (-not (Test-Path $FullPath)) {
        return
    }

    Write-Host "Copying $RelativePath ..." -ForegroundColor Cyan

    if ($Recursive) {
        scp -r "$FullPath" "${PiHost}:${RemoteTempDir}/"
    }
    else {
        scp "$FullPath" "${PiHost}:${RemoteTempDir}/"
    }
}

# Copy main runtime files
Copy-IfExists -RelativePath "scanner.js"
Copy-IfExists -RelativePath "configQr.js"
Copy-IfExists -RelativePath "package.json"
Copy-IfExists -RelativePath "package-lock.json"
Copy-IfExists -RelativePath "update-scanner.sh"

# Copy optional app directories
Copy-IfExists -RelativePath "kiosk" -Recursive

# Local repo folder is "display", but remote runtime expects "kiosk-display"
$LocalDisplayDir = Join-Path $LocalProjectDir "display"
if (Test-Path $LocalDisplayDir) {
    Write-Host "Copying kiosk-display ..." -ForegroundColor Cyan
    scp -r "$LocalProjectDir/display" "${PiHost}:${RemoteTempDir}/kiosk-display"
}

# Copy installer and systemd unit files
Write-Host "Copying provision assets..." -ForegroundColor Cyan
scp "$InstallerPath" "${PiHost}:${RemoteTempDir}/install-scanner.sh"

if (Test-Path $SystemdDir) {
    scp -r "$SystemdDir" "${PiHost}:${RemoteTempDir}/"
}

ssh $PiHost "chmod +x $RemoteTempDir/install-scanner.sh"
ssh $PiHost "if [ -f $RemoteTempDir/update-scanner.sh ]; then chmod +x $RemoteTempDir/update-scanner.sh; fi"
ssh $PiHost "if [ -d $RemoteTempDir/kiosk ]; then find $RemoteTempDir/kiosk -type f -name '*.sh' | xargs chmod +x; fi"

if (-not $SkipEnv) {
    Write-Host "Copying .env bundle asset..." -ForegroundColor Cyan
    scp "$ResolvedEnvPath" "${PiHost}:${RemoteTempDir}/.env"
}

Write-Host "Running installer on Pi..." -ForegroundColor Cyan
ssh -t $PiHost "sudo $RemoteTempDir/install-scanner.sh $RemoteTempDir"

Write-Host "Showing service status..." -ForegroundColor Cyan
ssh -t $PiHost "sudo systemctl --no-pager --full status multimedica-scanner.service || true"
ssh -t $PiHost "sudo systemctl --no-pager --full status kiosk-display.service || true"
ssh -t $PiHost "sudo systemctl --no-pager --full status kiosk.service || true"

Write-Host "Showing recent service logs..." -ForegroundColor Cyan
ssh -t $PiHost "journalctl -u multimedica-scanner.service -n 40 --no-pager || true"
ssh -t $PiHost "journalctl -u kiosk-display.service -n 40 --no-pager || true"
ssh -t $PiHost "journalctl -u kiosk.service -n 40 --no-pager || true"

Write-Host "Provisioning complete." -ForegroundColor Green