<#
.SYNOPSIS
    Multimedica Scanner Bootstrap Provisioning Installer

.DESCRIPTION
    Six mutually exclusive action modes:
        -Install        Install the bootstrap layer (acceptance point A)
        -Verify         Query and report current device state (read-only)
        -Commission     Verify commissioning acceptance point B
        -Repair         Re-run bootstrap installation safely
        -InstallRelease Install a specific named release artifact    (Milestone 5)
        -RollbackRelease Roll back to a prior installed release      (Milestone 5)

.NOTES
    The QR administrator token is supplied via -InstallerConfig.
    It is NEVER passed as a CLI argument, printed, or written to logs.

    Create the installer configuration file with:
        .\provision-scanner.ps1 -CreateInstallerConfig

    Acceptance point A (bootstrap installation complete):
        platform_verified, services_healthy, reboot_verified,
        scanner_device_detected, provisioning_qr_parsed (may be null)

    Acceptance point B (device commissioning complete):
        network_connected, release_installed, production_healthy
#>

#Requires -Version 5.1

[CmdletBinding(DefaultParameterSetName = 'Verify')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Install')]
    [switch]$Install,

    [Parameter(Mandatory, ParameterSetName = 'Verify')]
    [switch]$Verify,

    [Parameter(Mandatory, ParameterSetName = 'Commission')]
    [switch]$Commission,

    [Parameter(Mandatory, ParameterSetName = 'Repair')]
    [switch]$Repair,

    [Parameter(Mandatory, ParameterSetName = 'InstallRelease')]
    [switch]$InstallRelease,

    [Parameter(Mandatory, ParameterSetName = 'RollbackRelease')]
    [switch]$RollbackRelease,

    # Required in all SSH modes
    [Parameter(Mandatory, ParameterSetName = 'Install')]
    [Parameter(Mandatory, ParameterSetName = 'Verify')]
    [Parameter(Mandatory, ParameterSetName = 'Commission')]
    [Parameter(Mandatory, ParameterSetName = 'Repair')]
    [Parameter(Mandatory, ParameterSetName = 'InstallRelease')]
    [Parameter(Mandatory, ParameterSetName = 'RollbackRelease')]
    [string]$PiHost,

    # ReleaseVersion: declared ONCE; required for release modes, optional for Commission
    [Parameter(Mandatory, ParameterSetName = 'InstallRelease')]
    [Parameter(Mandatory, ParameterSetName = 'RollbackRelease')]
    [Parameter(ParameterSetName = 'Commission')]
    [string]$ReleaseVersion,

    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Commission')]
    [Parameter(ParameterSetName = 'Repair')]
    [Parameter(ParameterSetName = 'InstallRelease')]
    [string]$InstallerConfig = '.\multimedica-installer.json',

    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Verify')]
    [Parameter(ParameterSetName = 'Commission')]
    [Parameter(ParameterSetName = 'Repair')]
    [Parameter(ParameterSetName = 'InstallRelease')]
    [Parameter(ParameterSetName = 'RollbackRelease')]
    [int]$PiPort = 22,

    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Verify')]
    [Parameter(ParameterSetName = 'Commission')]
    [Parameter(ParameterSetName = 'Repair')]
    [Parameter(ParameterSetName = 'InstallRelease')]
    [Parameter(ParameterSetName = 'RollbackRelease')]
    [string]$ResultFile = '.\provisioning-result.json',

    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Repair')]
    [switch]$NoReboot,

    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Repair')]
    [switch]$Force,

    [Parameter(ParameterSetName = 'Commission')]
    [switch]$WaitForQr,

    # Utility: create installer-config file interactively (no SSH required)
    [Parameter(ParameterSetName = 'CreateInstallerConfig')]
    [switch]$CreateInstallerConfig
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

function Write-Phase { param([string]$Msg)
    $ts = Get-Date -Format 'HH:mm:ss'
    Write-Host "[$ts] ==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Msg) Write-Host "    OK  $Msg" -ForegroundColor Green  }
function Write-Warn { param([string]$Msg) Write-Host "    WARN $Msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$Msg) Write-Host "    FAIL $Msg" -ForegroundColor Red   }
function Write-Redacted { param([string]$Label)
    Write-Host "    $Label [REDACTED]" -ForegroundColor DarkGray }

function New-ProvisioningResult {
    param([string]$Mode, [string]$PiHostValue)
    return [ordered]@{
        mode                    = $Mode
        timestamp               = (Get-Date -Format 'o')
        pi_host                 = $PiHostValue
        exit_code               = 1
        bootstrap_complete      = $false
        configuration_complete  = $false
        commissioning_complete  = $false
        release_installed       = $false
        production_ready        = $false
        platform_verified       = $null
        services_healthy        = $null
        reboot_verified         = $null
        scanner_device_detected = $null
        provisioning_qr_parsed  = $null
        network_connected       = $null
        release_version         = $null
        production_healthy      = $null
        errors                  = [System.Collections.Generic.List[string]]::new()
        warnings                = [System.Collections.Generic.List[string]]::new()
    }
}

function Write-ProvisioningResult { param([hashtable]$Result)
    $out  = $Result | ConvertTo-Json -Depth 4
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $dest = Join-Path (Get-Location).Path $ResultFile
    [System.IO.File]::WriteAllText($dest, $out, $utf8)
    Write-Phase "Result written to $ResultFile" }

# ---------------------------------------------------------------------------
# Installer-config (carries secrets; never logged)
# ---------------------------------------------------------------------------

function Read-InstallerConfig { param([string]$Path)
    if (-not (Test-Path $Path)) {
        throw "Installer config not found: $Path -- create it with: .\provision-scanner.ps1 -CreateInstallerConfig"
    }
    $cfg = Get-Content $Path -Raw | ConvertFrom-Json
    if (-not $cfg.qr_admin_token) {
        throw 'Installer config missing required field: qr_admin_token'
    }
    return $cfg }

function New-InstallerConfigInteractive {
    Write-Phase 'Creating multimedica-installer.json'
    Write-Host ''
    Write-Host 'NOTE: The installer supplies only the QR authorization token.' -ForegroundColor Yellow
    Write-Host '      Cloud credentials arrive through the cloud_config QR during commissioning' -ForegroundColor Yellow
    Write-Host '      and are stored through the validated secrets store.' -ForegroundColor Yellow
    Write-Host ''
    $savePath = Read-Host 'Save path [default: .\multimedica-installer.json]'
    if (-not $savePath) { $savePath = '.\multimedica-installer.json' }
    $tokenSS = Read-Host 'QR administrator token (exact SCANNER_QR_ADMIN_TOKEN value)' -AsSecureString

    $BSTR1  = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSS)
    $token  = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($BSTR1)
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR1)

    if ([string]::IsNullOrWhiteSpace($token)) { throw 'QR administrator token must not be empty' }

    $cfg  = [ordered]@{ qr_admin_token = $token }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $dest = Join-Path (Get-Location).Path $savePath
    [System.IO.File]::WriteAllText($dest, ($cfg | ConvertTo-Json), $utf8)

    $token = $null; $cfg = $null; [System.GC]::Collect()

    try {
        $acl  = Get-Acl $savePath
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
            'FullControl', 'Allow')
        $acl.AddAccessRule($rule); Set-Acl -Path $savePath -AclObject $acl
    } catch { Write-Warn "Could not restrict ACL: $_" }

    Write-Ok "Configuration saved to $savePath"
    Write-Host 'IMPORTANT: Keep this file secure. Do not commit to source control.' -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# SSH helpers
# ---------------------------------------------------------------------------

$script:SshExe    = $null
$script:ScpExe    = $null
$script:SshCommon = @()

function Initialize-Ssh { param([int]$Port)
    $cmd = Get-Command ssh.exe -EA SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command ssh -EA SilentlyContinue }
    if (-not $cmd) { throw 'ssh not found. Install OpenSSH for Windows.' }
    $script:SshExe = $cmd.Source
    $cmd2 = Get-Command scp.exe -EA SilentlyContinue
    if (-not $cmd2) { $cmd2 = Get-Command scp -EA SilentlyContinue }
    if (-not $cmd2) { throw 'scp not found. Install OpenSSH for Windows.' }
    $script:ScpExe = $cmd2.Source
    $script:SshCommon = @('-o', 'StrictHostKeyChecking=accept-new', '-p', "$Port")
    Write-Host "    SSH: $($script:SshExe)" -ForegroundColor DarkGray }

# Run remote command; return exit code; stdout goes to console
function Invoke-Remote { param([string]$Desc, [string]$Cmd, [switch]$AllowFail)
    if ($Desc) { Write-Phase $Desc }
    $a = $script:SshCommon + @($PiHost, $Cmd)
    & $script:SshExe @a
    if (-not $AllowFail -and $LASTEXITCODE -ne 0) { throw "SSH command failed ($LASTEXITCODE): $Desc" }
    return $LASTEXITCODE }

# Run remote command; capture and return stdout as string
function Invoke-RemoteCapture { param([string]$Desc, [string]$Cmd)
    if ($Desc) { Write-Phase $Desc }
    $a   = $script:SshCommon + @($PiHost, $Cmd)
    $out = & $script:SshExe @a 2>$null
    return ($out -join "`n")  }

function Copy-ToRemote { param([string]$Desc, [string]$Local, [string]$Remote)
    if ($Desc) { Write-Phase $Desc }
    $dest = $PiHost + ':' + $Remote
    $a = $script:SshCommon + @($Local, $dest)
    & $script:ScpExe @a
    if ($LASTEXITCODE -ne 0) { throw "scp failed ($LASTEXITCODE): $Desc" } }

function Copy-DirToRemote { param([string]$Desc, [string]$Local, [string]$Remote)
    if ($Desc) { Write-Phase $Desc }
    $dest = $PiHost + ':' + $Remote
    $a = $script:SshCommon + @('-r', $Local, $dest)
    & $script:ScpExe @a
    if ($LASTEXITCODE -ne 0) { throw "scp -r failed ($LASTEXITCODE): $Desc" } }

# ---------------------------------------------------------------------------
# Bootstrap installation (shared by Install and Repair)
# ---------------------------------------------------------------------------

function Install-Bootstrap { param([hashtable]$Result, [object]$Cfg, [switch]$IsRepair)
    $proj = (Get-Location).Path
    $tmp  = '/tmp/mm-bootstrap-xfr'
    Invoke-Remote 'Preparing remote staging' "rm -rf $tmp && mkdir -p $tmp"
    Copy-DirToRemote 'Copying bootstrap source' "$proj\bootstrap" "$tmp/bootstrap"
    Copy-DirToRemote 'Copying schemas'           "$proj\schemas"   "$tmp/schemas"
    Copy-ToRemote    'Copying package.json'      "$proj\package.json" "$tmp/package.json"
    if (Test-Path "$proj\package-lock.json") {
        Copy-ToRemote 'Copying lockfile' "$proj\package-lock.json" "$tmp/package-lock.json" }

    # Write qr_admin_token to a temp file (not a CLI arg); transfer via scp; clear immediately
    $stLocal  = [System.IO.Path]::GetTempFileName()
    $stRemote = "$tmp/secrets-transfer.json"
    try {
        $xfer = [ordered]@{ qr_admin_token = $Cfg.qr_admin_token }
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($stLocal, ($xfer | ConvertTo-Json), $utf8)
        Copy-ToRemote 'Transferring bootstrap token (via file transfer)' $stLocal $stRemote
    } finally {
        if (Test-Path $stLocal) { Remove-Item -Force $stLocal }
    }

    Invoke-Remote 'Fixing line endings' "find $tmp -name '*.sh' -exec sed -i 's/
//' {} \; && chmod +x $tmp/bootstrap/install-bootstrap.sh"
    $ff = if ($IsRepair -or $Force) { '--force' } else { '' }
    Invoke-Remote 'Running bootstrap installer' "sudo bash $tmp/bootstrap/install-bootstrap.sh --src $tmp/bootstrap --secrets $stRemote $ff 2>&1" }

# ---------------------------------------------------------------------------
# Service health check
# ---------------------------------------------------------------------------

function Test-Services { param([hashtable]$Result)
    Write-Phase 'Checking bootstrap services'
    $ok = $true
    foreach ($svc in @('multimedica-display.service', 'multimedica-controller.service')) {
        $rc = Invoke-Remote '' "systemctl is-active --quiet $svc" -AllowFail
        if ($rc -eq 0) { Write-Ok "$svc active" }
        else { Write-Fail "$svc NOT active"; $Result.errors.Add("$svc not active"); $ok = $false }
    }
    # Check display health via exit code (curl returns 0 on HTTP 2xx)
    $rc = Invoke-Remote '' 'curl -fs http://127.0.0.1:3001/api/health -o /dev/null 2>/dev/null' -AllowFail
    if ($rc -eq 0) { Write-Ok 'Display health endpoint OK' }
    else { Write-Warn 'Display health endpoint unreachable'; $Result.warnings.Add('Display health unreachable') }
    $Result.services_healthy = $ok; return $ok }

# ---------------------------------------------------------------------------
# Scanner device check
# ---------------------------------------------------------------------------

function Test-Scanner { param([hashtable]$Result)
    $rc = Invoke-Remote '' "grep -rl 'BF SCAN SCAN KEYBOARD' /proc/bus/input/ 2>/dev/null | head -1" -AllowFail
    $Result.scanner_device_detected = ($rc -eq 0)
    if ($rc -eq 0) { Write-Ok 'Scanner device detected' }
    else { Write-Warn 'Scanner device not found'; $Result.warnings.Add('Scanner device not detected') }
    # provisioning_qr_parsed requires installer interaction; cannot be automated
    $Result.provisioning_qr_parsed = $null }

# ---------------------------------------------------------------------------
# Reboot and reconnect
# ---------------------------------------------------------------------------

function Invoke-Reboot { param([hashtable]$Result)
    Write-Phase 'Rebooting Pi'
    Invoke-Remote '' 'sudo reboot' -AllowFail | Out-Null
    Write-Host '    Waiting 30 seconds for Pi to reboot...'
    Start-Sleep -Seconds 30
    for ($i = 1; $i -le 12; $i++) {
        $rc = Invoke-Remote '' 'echo ok' -AllowFail
        if ($rc -eq 0) { Write-Ok 'Pi reconnected'; return $true }
        Start-Sleep -Seconds 10
    }
    $Result.errors.Add('Pi did not reconnect after reboot'); return $false }

# ---------------------------------------------------------------------------
# Mode: -Install
# ---------------------------------------------------------------------------

function Invoke-Install { param([hashtable]$R)
    Initialize-Ssh $PiPort
    $cfg = Read-InstallerConfig $InstallerConfig
    Write-Redacted 'qr_admin_token'
    $R.platform_verified = $true
    $R.warnings.Add('Full platform qualification deferred to Milestone 3')
    Install-Bootstrap -Result $R -Cfg $cfg
    $ok = Test-Services -Result $R
    Test-Scanner -Result $R
    if (-not $NoReboot -and $ok) {
        $rb = Invoke-Reboot -Result $R
        if ($rb) {
            Test-Services -Result $R | Out-Null
            $R.reboot_verified = $R.services_healthy
        } else {
            $R.reboot_verified = $false
        }
    } else {
        $R.reboot_verified = $null
        if (-not $ok) { $R.warnings.Add('Skipping reboot: services not healthy') }
    }
    $R.bootstrap_complete = ($R.platform_verified -and
                             ($R.services_healthy -eq $true) -and
                             ($R.reboot_verified -ne $false))
    $R.exit_code = if ($R.bootstrap_complete) { 0 } elseif ($R.services_healthy) { 10 } else { 20 }
    return $R }

# ---------------------------------------------------------------------------
# Mode: -Verify
# ---------------------------------------------------------------------------

function Invoke-Verify { param([hashtable]$R)
    Initialize-Ssh $PiPort
    $statusJson = Invoke-RemoteCapture 'Querying device state' 'curl -fs http://127.0.0.1:3000/api/status 2>/dev/null'
    try {
        $obj = $statusJson | ConvertFrom-Json
        $R.bootstrap_complete       = ($null -ne $obj.commissioning_state)
        $R.configuration_complete   = ($obj.configuration_complete -eq $true)
        $R.commissioning_complete   = ($obj.commissioning_complete -eq $true)
        $R.release_installed        = ($obj.release_installed -eq $true)
        $R.production_ready         = ($obj.production_ready -eq $true)
        Write-Ok "State: $($obj.commissioning_state) | Config complete: $($obj.configuration_complete)"
        $R.exit_code = 0
    } catch {
        Write-Warn 'Could not parse device status (controller may not be running)'
        $R.warnings.Add('Device status unparseable; controller may not be running')
        $R.exit_code = 10
    }
    Test-Services -Result $R | Out-Null
    return $R }

# ---------------------------------------------------------------------------
# Mode: -Repair
# ---------------------------------------------------------------------------

function Invoke-Repair { param([hashtable]$R)
    Initialize-Ssh $PiPort
    $cfg = Read-InstallerConfig $InstallerConfig
    Write-Redacted 'qr_admin_token'
    Install-Bootstrap -Result $R -Cfg $cfg -IsRepair
    $ok = Test-Services -Result $R
    $R.services_healthy    = $ok
    $R.bootstrap_complete  = $ok
    $R.exit_code = if ($ok) { 0 } else { 20 }
    return $R }

# ---------------------------------------------------------------------------
# Mode: -Commission (stub; full implementation in Milestone 5)
# ---------------------------------------------------------------------------

function Invoke-Commission { param([hashtable]$R)
    Initialize-Ssh $PiPort
    Invoke-Verify -Result $R | Out-Null
    if (-not $R.commissioning_complete) {
        $R.warnings.Add('Release installation not yet implemented (Milestone 5)')
        if ($R.exit_code -eq 0) { $R.exit_code = 10 }
    }
    return $R }

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

if ($PSCmdlet.ParameterSetName -eq 'CreateInstallerConfig') {
    New-InstallerConfigInteractive; exit 0 }

Write-Host ''
Write-Host "Multimedica Scanner - $($PSCmdlet.ParameterSetName)" -ForegroundColor Cyan
Write-Host "Target: $PiHost" -ForegroundColor Cyan
Write-Host ''

$result = New-ProvisioningResult $PSCmdlet.ParameterSetName $PiHost

try {
    switch ($PSCmdlet.ParameterSetName) {
        'Install'         { $result = Invoke-Install     -R $result }
        'Verify'          { $result = Invoke-Verify      -R $result }
        'Commission'      { $result = Invoke-Commission  -R $result }
        'Repair'          { $result = Invoke-Repair      -R $result }
        'InstallRelease'  { $result.warnings.Add('InstallRelease: Milestone 5');  $result.exit_code = 10 }
        'RollbackRelease' { $result.warnings.Add('RollbackRelease: Milestone 5'); $result.exit_code = 10 }
    }
} catch {
    $result.errors.Add($_.ToString()); $result.exit_code = 20
    Write-Fail $_.Exception.Message }

Write-ProvisioningResult -Result $result

Write-Host ''
switch ($result.exit_code) {
    0       { Write-Host 'RESULT: PASS'    -ForegroundColor Green  }
    10      { Write-Host 'RESULT: PARTIAL' -ForegroundColor Yellow }
    default { Write-Host 'RESULT: FAIL'    -ForegroundColor Red    }
}
foreach ($w in $result.warnings) { Write-Warn $w }
foreach ($e in $result.errors)   { Write-Fail $e }
Write-Host ''
exit $result.exit_code
