param(
    [string]$PiHost = "multimedica_edge@multimedicascanner1.local",
    [string]$LocalProjectDir = ".",
    [string]$LocalEnvFile = ".env",
    [string]$RemoteTempDir = "/home/multimedica_edge/provisioning",
    [switch]$SkipEnv
)

$ErrorActionPreference = "Stop"

Write-Host "Provisioning scanner on $PiHost ..." -ForegroundColor Cyan

# Check required commands
$scp = Get-Command scp -ErrorAction SilentlyContinue
$ssh = Get-Command ssh -ErrorAction SilentlyContinue

if (-not $scp) {
    throw "scp not found. Install OpenSSH client on Windows or make sure it is in PATH."
}

if (-not $ssh) {
    throw "ssh not found. Install OpenSSH client on Windows or make sure it is in PATH."
}

# Resolve local paths
$LocalProjectDir = (Resolve-Path $LocalProjectDir).Path
$InstallerPath = Join-Path $LocalProjectDir (Join-Path "provision" "install-scanner.sh")

if (-not (Test-Path $InstallerPath)) {
    throw "install-scanner.sh not found at: $InstallerPath"
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

# Ensure remote temp directory exists
Write-Host "Creating remote temp directory..." -ForegroundColor Cyan
ssh $PiHost "mkdir -p $RemoteTempDir"

# Copy installer
Write-Host "Copying install-scanner.sh..." -ForegroundColor Cyan
scp "$InstallerPath" "${PiHost}:${RemoteTempDir}/install-scanner.sh"

# Make installer executable
Write-Host "Setting installer permissions..." -ForegroundColor Cyan
ssh $PiHost "chmod +x $RemoteTempDir/install-scanner.sh"

# Run installer with sudo
Write-Host "Running installer on Pi..." -ForegroundColor Cyan
ssh -t $PiHost "sudo $RemoteTempDir/install-scanner.sh"

# Copy .env if requested
if (-not $SkipEnv) {
    Write-Host "Copying .env to /opt/multimedica-scanner/.env ..." -ForegroundColor Cyan
    scp "$ResolvedEnvPath" "${PiHost}:${RemoteTempDir}/.env"

    Write-Host "Installing .env into app directory..." -ForegroundColor Cyan
    ssh -t $PiHost "sudo cp $RemoteTempDir/.env /opt/multimedica-scanner/.env && sudo chown multimedica_edge:multimedica_edge /opt/multimedica-scanner/.env"
}

# Restart service
Write-Host "Restarting service..." -ForegroundColor Cyan
ssh -t $PiHost "sudo systemctl restart multimedica-scanner.service"

# Show service status
Write-Host "Showing service status..." -ForegroundColor Cyan
ssh -t $PiHost "sudo systemctl --no-pager --full status multimedica-scanner.service"

Write-Host "Showing recent service logs..." -ForegroundColor Cyan
ssh -t $PiHost "journalctl -u multimedica-scanner.service -n 50 --no-pager"

Write-Host "Provisioning complete." -ForegroundColor Green