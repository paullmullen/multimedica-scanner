<#
.SYNOPSIS
    Performs the Pi-side bootstrap installation over SSH.
    Called by provision-scanner.ps1 in -Install and -Repair modes.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][hashtable]$Result,
    [Parameter(Mandatory)][object]   $Cfg,
    [Parameter(Mandatory)][string]   $PiHost,
    [Parameter(Mandatory)][int]      $PiPort,
    [Parameter(Mandatory)][string]   $SshExe,
    [Parameter(Mandatory)][string]   $ScpExe,
    [switch] $Force
)

# This helper is sourced/called by provision-scanner.ps1.
# All secret handling rules from the parent script apply here.
# The qr_admin_token in $Cfg is NEVER written to output or logged.

$SshCommon = @('-o','StrictHostKeyChecking=accept-new','-p',"$PiPort")
$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$RemoteTemp = '/tmp/mm-bootstrap-xfr'

function _Remote { param([string]$Desc,[string]$Cmd,[switch]$AllowFail)
    if ($Desc) { Write-Host "==> $Desc" }
    & $SshExe @SshCommon $PiHost $Cmd
    if (-not $AllowFail -and $LASTEXITCODE -ne 0) { throw "SSH failed: $Desc" }
    return $LASTEXITCODE }

function _SCP { param([string]$Desc,[string]$Src,[string]$Dst)
    if ($Desc) { Write-Host "==> $Desc" }
    & $ScpExe @SshCommon $Src "${PiHost}:${Dst}"
    if ($LASTEXITCODE -ne 0) { throw "SCP failed: $Desc" } }

function _SCP_R { param([string]$Desc,[string]$Src,[string]$Dst)
    if ($Desc) { Write-Host "==> $Desc" }
    & $ScpExe @SshCommon '-r' $Src "${PiHost}:${Dst}"
    if ($LASTEXITCODE -ne 0) { throw "SCP -r failed: $Desc" } }

_Remote 'Preparing remote staging' "rm -rf $RemoteTemp && mkdir -p $RemoteTemp"
_SCP_R  'Copying bootstrap source'  "$ProjectDir\bootstrap" "$RemoteTemp/bootstrap"
_SCP_R  'Copying schemas'           "$ProjectDir\schemas"   "$RemoteTemp/schemas"
_SCP    'Copying package.json'      "$ProjectDir\package.json" "$RemoteTemp/package.json"
if (Test-Path "$ProjectDir\package-lock.json") {
    _SCP 'Copying lockfile' "$ProjectDir\package-lock.json" "$RemoteTemp/package-lock.json" }

# Transfer qr_admin_token via temp file, not as a shell argument
$localTemp  = [System.IO.Path]::GetTempFileName()
$remoteTemp = "$RemoteTemp/secrets-transfer.json"
try {
    $xfer  = [ordered]@{ qr_admin_token = $Cfg.qr_admin_token }
    $Utf8  = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($localTemp, ($xfer | ConvertTo-Json), $Utf8)
    _SCP 'Transferring bootstrap token' $localTemp $remoteTemp
} finally {
    if (Test-Path $localTemp) { Remove-Item -Force $localTemp }
}

_Remote 'Fixing line endings' "find $RemoteTemp -name '*.sh' -exec sed -i 's/\r$//' {} \; && chmod +x $RemoteTemp/bootstrap/install-bootstrap.sh"
$ff = if ($Force) { '--force' } else { '' }
_Remote 'Running bootstrap installer (may take several minutes)' `
    "sudo bash $RemoteTemp/bootstrap/install-bootstrap.sh --src $RemoteTemp/bootstrap --secrets $remoteTemp $ff 2>&1"

Write-Host "Bootstrap installation command completed"
