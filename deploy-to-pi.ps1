param(
    [string]$PiHost = "multimedica_edge@multimedicascanner1.local",
    [string]$RemoteAppDir = "/home/multimedica_edge/scanner",
    [string]$LocalProjectDir = "."
)

$ErrorActionPreference = "Stop"

Write-Host "Deploying scanner project to $PiHost ..." -ForegroundColor Cyan

# Check required commands
$scp = Get-Command scp -ErrorAction SilentlyContinue
$ssh = Get-Command ssh -ErrorAction SilentlyContinue

if (-not $scp) {
    throw "scp not found. Install OpenSSH client on Windows or make sure it is in PATH."
}

if (-not $ssh) {
    throw "ssh not found. Install OpenSSH client on Windows or make sure it is in PATH."
}

# Resolve local path
$LocalProjectDir = (Resolve-Path $LocalProjectDir).Path

Write-Host "Local project: $LocalProjectDir" -ForegroundColor Yellow
Write-Host "Remote app dir: $RemoteAppDir" -ForegroundColor Yellow

# Ensure remote directory exists
Write-Host "Creating remote directory if needed..." -ForegroundColor Cyan
ssh $PiHost "mkdir -p $RemoteAppDir"

# Copy project files
# This copies the key runtime/deployment files.
Write-Host "Copying files..." -ForegroundColor Cyan
scp `
    "$LocalProjectDir\scanner.js" `
    "$LocalProjectDir\install-scanner.sh" `
    "$LocalProjectDir\update-scanner.sh" `
    "$LocalProjectDir\package.json" `
    "$LocalProjectDir\package-lock.json" `
    "${PiHost}:${RemoteAppDir}/"

# Ensure installer scripts are executable
Write-Host "Setting script permissions..." -ForegroundColor Cyan
ssh $PiHost "chmod +x $RemoteAppDir/install-scanner.sh $RemoteAppDir/update-scanner.sh"

# Run installer
Write-Host "Running installer on Pi..." -ForegroundColor Cyan
ssh $PiHost "cd $RemoteAppDir && ./install-scanner.sh"

# Show final status
Write-Host "Showing service status..." -ForegroundColor Cyan
ssh $PiHost "sudo systemctl --no-pager --full status scanner.service"

Write-Host "Deploy complete." -ForegroundColor Green