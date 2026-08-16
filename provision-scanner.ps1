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

    One SSH setup utility:
        -ConfigureSshAccess  Install and verify the workstation's dedicated
                             provisioning public key on the Pi

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

    [Parameter(Mandatory, ParameterSetName = 'ConfigureSshAccess')]
    [switch]$ConfigureSshAccess,

    # Required in all SSH modes
    [Parameter(Mandatory, ParameterSetName = 'Install')]
    [Parameter(Mandatory, ParameterSetName = 'Verify')]
    [Parameter(Mandatory, ParameterSetName = 'Commission')]
    [Parameter(Mandatory, ParameterSetName = 'Repair')]
    [Parameter(Mandatory, ParameterSetName = 'InstallRelease')]
    [Parameter(Mandatory, ParameterSetName = 'RollbackRelease')]
    [Parameter(Mandatory, ParameterSetName = 'ConfigureSshAccess')]
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
    [Parameter(ParameterSetName = 'ConfigureSshAccess')]
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
    [switch]$CreateInstallerConfig,

    [Parameter(ParameterSetName = 'CreateInstallerConfig')]
    [ValidatePattern('^[a-z][a-z0-9-]{3,28}[a-z0-9]$')]
    [string]$FirebaseProjectId
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

function Resolve-FirebaseExecutable {
    foreach ($name in @('firebase.cmd', 'firebase.exe', 'firebase')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and $command.Source) { return $command.Source }
    }
    throw 'Firebase CLI executable not found. Install Firebase CLI or omit -FirebaseProjectId for offline recovery.'
}

function Get-FirebaseSecretToken {
    param([string]$ProjectId)

    if ($ProjectId -notmatch '^[a-z][a-z0-9-]{3,28}[a-z0-9]$') {
        throw 'Invalid Firebase project ID.'
    }

    $firebase = Resolve-FirebaseExecutable
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $firebase
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.Arguments = "functions:secrets:access SCANNER_QR_ADMIN_TOKEN --project $ProjectId"

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Firebase CLI could not be started.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        $stdout = $stdoutTask.Result
        $null = $stderrTask.Result

        if ($process.ExitCode -ne 0) {
            throw 'Firebase CLI could not access SCANNER_QR_ADMIN_TOKEN.'
        }

        $token = $stdout -replace '(\r\n|\n|\r)$', ''
        if ([string]::IsNullOrEmpty($token) -or $token.Contains("`r") -or $token.Contains("`n")) {
            throw 'Firebase CLI returned an invalid token response.'
        }
        return $token
    } catch [System.Management.Automation.RuntimeException] {
        throw $_.Exception.Message
    } catch {
        throw 'Firebase CLI secret retrieval failed.'
    } finally {
        if ($process) { $process.Dispose() }
        $stdout = $null
        $stderr = $null
        $stdoutTask = $null
        $stderrTask = $null
    }
}

function Protect-InstallerConfigFile {
    param([string]$Path)

    # Set only the discretionary access rules. Set-Acl can attempt to write
    # audit-control data on some Windows configurations, which unnecessarily
    # requires SeSecurityPrivilege. icacls restricts this user-owned file
    # without requiring an elevated PowerShell process.
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    if (-not (Test-Path $icacls)) {
        throw 'Windows ACL utility not found.'
    }

    $output = & $icacls $Path '/inheritance:r' '/grant:r' "${identity}:(F)" '*S-1-5-18:(F)' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Could not restrict installer config permissions: $($output -join ' ')"
    }
}

function New-InstallerConfigInteractive {
    Write-Phase 'Creating multimedica-installer.json'
    Write-Host ''
    Write-Host 'NOTE: The installer supplies only the QR authorization token.' -ForegroundColor Yellow
    Write-Host '      Cloud credentials arrive through the cloud_config QR during commissioning' -ForegroundColor Yellow
    Write-Host '      and are stored through the validated secrets store.' -ForegroundColor Yellow
    Write-Host ''
    $savePath = Read-Host 'Save path [default: .\multimedica-installer.json]'
    if (-not $savePath) { $savePath = '.\multimedica-installer.json' }
    $dest = Join-Path (Get-Location).Path $savePath
    if (Test-Path $dest) {
        $replace = Read-Host 'Installer config exists. Replace it? [yes/no]'
        if ($replace -notmatch '^(?i:yes)$') { throw 'Existing installer config was not replaced.' }
    }

    $token = $null
    $candidate = "$dest.candidate"
    $backup = $null
    $replaceCompleted = $false
    try {
        if ($FirebaseProjectId) {
            Write-Phase "Retrieving SCANNER_QR_ADMIN_TOKEN metadata for project $FirebaseProjectId"
            $token = Get-FirebaseSecretToken -ProjectId $FirebaseProjectId
        } else {
            $tokenSS = Read-Host 'QR administrator token (exact SCANNER_QR_ADMIN_TOKEN value)' -AsSecureString
            $BSTR1 = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSS)
            try { $token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($BSTR1) }
            finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR1) }
        }

        if ([string]::IsNullOrWhiteSpace($token)) { throw 'QR administrator token must not be empty' }
        $cfg = [ordered]@{ qr_admin_token = $token }
        if ($cfg.Keys.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$cfg.qr_admin_token)) {
            throw 'Installer config validation failed.'
        }

        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($candidate, ($cfg | ConvertTo-Json), $utf8)
        Protect-InstallerConfigFile -Path $candidate

        if (Test-Path $dest) {
            $backup = "$dest.backup.$([Guid]::NewGuid().ToString('N'))"
            [System.IO.File]::Replace($candidate, $dest, $backup)
            Protect-InstallerConfigFile -Path $dest
            $replaceCompleted = $true
            [System.IO.File]::Delete($backup)
            $backup = $null
        } else {
            [System.IO.File]::Move($candidate, $dest)
        }
        Write-Ok "Configuration saved to $savePath"
        Write-Host 'IMPORTANT: Keep this file secure. Do not commit to source control.' -ForegroundColor Yellow
    } catch {
        if (Test-Path $candidate) { Remove-Item -Force $candidate -ErrorAction SilentlyContinue }
        throw $_.Exception.Message
    } finally {
        if ($backup -and (Test-Path $backup)) {
            if (-not $replaceCompleted) {
                if (Test-Path $dest) { [System.IO.File]::Delete($dest) }
                [System.IO.File]::Move($backup, $dest)
            } else {
                [System.IO.File]::Delete($backup)
            }
        }
        $token = $null
        $cfg = $null
        $tokenSS = $null
        $BSTR1 = $null
        [System.GC]::Collect()
    }
}

# ---------------------------------------------------------------------------
# SSH helpers
# ---------------------------------------------------------------------------

$script:SshExe    = $null
$script:ScpExe    = $null
$script:SshCommon = @()
$script:ScpCommon = @()
$script:ProvisioningKey = Join-Path $env:USERPROFILE '.ssh\multimedica_scanner_ed25519'

function Initialize-Ssh { param([int]$Port, [switch]$AllowPassword)
    $cmd = Get-Command ssh.exe -EA SilentlyContinue
    if (-not $cmd) { $cmd = Get-Command ssh -EA SilentlyContinue }
    if (-not $cmd) { throw 'ssh not found. Install OpenSSH for Windows.' }
    $script:SshExe = $cmd.Source
    $cmd2 = Get-Command scp.exe -EA SilentlyContinue
    if (-not $cmd2) { $cmd2 = Get-Command scp -EA SilentlyContinue }
    if (-not $cmd2) { throw 'scp not found. Install OpenSSH for Windows.' }
    $script:ScpExe = $cmd2.Source
    $identityArgs = @()
    if (Test-Path -LiteralPath $script:ProvisioningKey) {
        $identityArgs = @('-i', $script:ProvisioningKey, '-o', 'IdentitiesOnly=yes')
    }
    $script:SshCommon = @('-o', 'StrictHostKeyChecking=accept-new', '-p', "$Port") + $identityArgs
    $script:ScpCommon = @('-o', 'StrictHostKeyChecking=accept-new', '-P', "$Port") + $identityArgs
    if (-not $AllowPassword) {
        if (-not $identityArgs.Count) {
            throw 'Provisioning SSH key not found. Run: .\provision-scanner.ps1 -ConfigureSshAccess -PiHost <user@host>'
        }
        $testArgs = $script:SshCommon + @('-o', 'BatchMode=yes', $PiHost, 'true')
        & $script:SshExe @testArgs 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw 'Key-based SSH verification failed. Run: .\provision-scanner.ps1 -ConfigureSshAccess -PiHost <user@host>'
        }
    }
    Write-Host "    SSH: $($script:SshExe)" -ForegroundColor DarkGray }

function Invoke-ConfigureSshAccess {
    $keyDir = Split-Path -Parent $script:ProvisioningKey
    if (-not (Test-Path -LiteralPath $keyDir)) {
        New-Item -ItemType Directory -Path $keyDir -Force | Out-Null
    }

    if (-not (Test-Path -LiteralPath $script:ProvisioningKey)) {
        $keygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue
        if (-not $keygen) { $keygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue }
        if (-not $keygen) { throw 'ssh-keygen not found. Install OpenSSH for Windows.' }
        Write-Phase 'Creating dedicated Multimedica provisioning SSH key'
        & $keygen.Source -q -t ed25519 -f $script:ProvisioningKey -N '""' -C 'multimedica-scanner-provisioning'
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create provisioning SSH key.' }
    } else {
        Write-Ok 'Dedicated Multimedica provisioning SSH key already exists'
    }

    if (-not (Test-Path -LiteralPath "$($script:ProvisioningKey).pub")) {
        throw 'Provisioning SSH public key is missing.'
    }

    Initialize-Ssh -Port $PiPort -AllowPassword
    Write-Phase 'Installing provisioning public key on Pi (one password entry expected)'
    $publicKeyText = (Get-Content -LiteralPath "$($script:ProvisioningKey).pub" -Raw).TrimEnd() + "`n"
    $publicKeyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($publicKeyText))
    $remote = 'set -e; umask 077; mkdir -p $HOME/.ssh; touch $HOME/.ssh/authorized_keys; printf %s ' +
              $publicKeyBase64 +
              ' | base64 -d > $HOME/.ssh/.multimedica_key_candidate; grep -qxF -f $HOME/.ssh/.multimedica_key_candidate $HOME/.ssh/authorized_keys || cat $HOME/.ssh/.multimedica_key_candidate >> $HOME/.ssh/authorized_keys; rm -f $HOME/.ssh/.multimedica_key_candidate; chmod 700 $HOME/.ssh; chmod 600 $HOME/.ssh/authorized_keys'
    $installArgs = $script:SshCommon + @($PiHost, $remote)
    & $script:SshExe @installArgs
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install provisioning public key on Pi.' }

    $testArgs = $script:SshCommon + @('-o', 'BatchMode=yes', $PiHost, 'true')
    & $script:SshExe @testArgs
    if ($LASTEXITCODE -ne 0) { throw 'Provisioning public key was installed but verification failed.' }
    Write-Ok 'Key-based SSH verified; provisioning will not prompt for the Pi password'
}

# Run remote command; return exit code; stdout goes to console
function Invoke-Remote { param([string]$Desc, [string]$Cmd, [switch]$AllowFail)
    if ($Desc) { Write-Phase $Desc }
    $a = $script:SshCommon + @($PiHost, $Cmd)
    $remoteOutput = @(& $script:SshExe @a 2>&1)
    $remoteExitCode = $LASTEXITCODE
    foreach ($line in $remoteOutput) { Write-Host $line }
    if (-not $AllowFail -and $remoteExitCode -ne 0) {
        $detail = ($remoteOutput | Where-Object { -not [string]::IsNullOrWhiteSpace("$_") } | Select-Object -Last 1)
        if ($detail) { throw "SSH command failed ($remoteExitCode): $Desc -- Remote: $detail" }
        throw "SSH command failed ($remoteExitCode): $Desc"
    }
    return $remoteExitCode }

# Run remote command; capture and return stdout as string
function Invoke-RemoteCapture { param([string]$Desc, [string]$Cmd)
    if ($Desc) { Write-Phase $Desc }
    $a   = $script:SshCommon + @($PiHost, $Cmd)
    $out = & $script:SshExe @a 2>$null
    return ($out -join "`n")  }

function Copy-ToRemote { param([string]$Desc, [string]$Local, [string]$Remote)
    if ($Desc) { Write-Phase $Desc }
    $dest = $PiHost + ':' + $Remote
    $a = $script:ScpCommon + @($Local, $dest)
    $copyOutput = @(& $script:ScpExe @a 2>&1)
    $copyExitCode = $LASTEXITCODE
    foreach ($line in $copyOutput) { Write-Host $line }
    if ($copyExitCode -ne 0) { throw "scp failed ($copyExitCode): $Desc" } }

function Copy-DirToRemote { param([string]$Desc, [string]$Local, [string]$Remote)
    if ($Desc) { Write-Phase $Desc }
    $dest = $PiHost + ':' + $Remote
    $a = $script:ScpCommon + @('-r', $Local, $dest)
    $copyOutput = @(& $script:ScpExe @a 2>&1)
    $copyExitCode = $LASTEXITCODE
    foreach ($line in $copyOutput) { Write-Host $line }
    if ($copyExitCode -ne 0) { throw "scp -r failed ($copyExitCode): $Desc" } }

# ---------------------------------------------------------------------------
# Bootstrap installation (shared by Install and Repair)
# ---------------------------------------------------------------------------

function Install-Bootstrap { param([hashtable]$Result, [object]$Cfg, [switch]$IsRepair)
    $proj = (Get-Location).Path
    $tmp  = '/tmp/mm-bootstrap-xfr'
    $null = Invoke-Remote 'Preparing remote staging' "rm -rf $tmp && mkdir -p $tmp"
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

    $null = Invoke-Remote 'Fixing line endings' "find $tmp -name '*.sh' -exec sed -i 's/\x0D$//' {} \; && chmod +x $tmp/bootstrap/install-bootstrap.sh"
    $ff = if ($IsRepair -or $Force) { '--force' } else { '' }
    Write-Warn 'The first clean-image bootstrap can take several minutes while OS and npm packages are installed.'
    Write-Warn 'Do not interrupt the installer while package output continues; later reruns should be faster.'
    $null = Invoke-Remote 'Running bootstrap installer' "sudo bash $tmp/bootstrap/install-bootstrap.sh --src $tmp/bootstrap --secrets $stRemote $ff 2>&1" }

# ---------------------------------------------------------------------------
# Service health check
# ---------------------------------------------------------------------------

function Test-Services { param([hashtable]$Result)
    Write-Phase 'Checking bootstrap services'
    $ok = $true
    foreach ($svc in @('multimedica-display.service', 'multimedica-controller.service', 'multimedica-kiosk.service')) {
        $rc = Invoke-Remote '' "systemctl is-active --quiet $svc" -AllowFail
        if ($rc -eq 0) { Write-Ok "$svc active" }
        else { Write-Fail "$svc NOT active"; $Result.errors.Add("$svc not active"); $ok = $false }
    }
    # Check display health via exit code (curl returns 0 on HTTP 2xx)
    $rc = Invoke-Remote '' 'curl -fs http://127.0.0.1:3001/api/health -o /dev/null 2>/dev/null' -AllowFail
    if ($rc -eq 0) { Write-Ok 'Display health endpoint OK' }
    else { Write-Warn 'Display health endpoint unreachable'; $Result.warnings.Add('Display health unreachable') }
    # The HTTP endpoint alone does not prove that the physical screen is showing it.
    $rc = Invoke-Remote '' "pgrep -u multimedica_edge -f 'chromium.*127.0.0.1:3001' >/dev/null" -AllowFail
    if ($rc -eq 0) { Write-Ok 'Physical kiosk browser process active' }
    else { Write-Fail 'Physical kiosk browser process NOT active'; $Result.errors.Add('Physical kiosk browser not active'); $ok = $false }
    $Result.services_healthy = $ok; return $ok }

# ---------------------------------------------------------------------------
# Scanner device check
# ---------------------------------------------------------------------------

function Test-Scanner { param([hashtable]$Result)
    Write-Phase 'Checking scanner input path'
    $deviceRc = Invoke-Remote '' "grep -Fq 'BF SCAN SCAN KEYBOARD' /proc/bus/input/devices 2>/dev/null" -AllowFail
    $readerRc = Invoke-Remote '' "pgrep -u multimedica_edge -x evtest >/dev/null" -AllowFail
    $scannerOk = ($deviceRc -eq 0 -and $readerRc -eq 0)
    $Result.scanner_device_detected = $scannerOk
    if ($deviceRc -eq 0) { Write-Ok 'Scanner USB device detected' }
    else { Write-Fail 'Scanner USB device not found'; $Result.errors.Add('Scanner USB device not detected') }
    if ($readerRc -eq 0) { Write-Ok 'Scanner evtest reader active' }
    else { Write-Fail 'Scanner evtest reader NOT active'; $Result.errors.Add('Scanner evtest reader not active') }
    # provisioning_qr_parsed requires installer interaction; cannot be automated
    $Result.provisioning_qr_parsed = $null
    return $scannerOk }

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
    $scannerOk = Test-Scanner -Result $R
    if (-not $NoReboot -and $ok -and $scannerOk) {
        $rb = Invoke-Reboot -Result $R
        if ($rb) {
            Test-Services -Result $R | Out-Null
            $scannerAfterReboot = Test-Scanner -Result $R
            $R.reboot_verified = ($R.services_healthy -and $scannerAfterReboot)
        } else {
            $R.reboot_verified = $false
        }
    } else {
        $R.reboot_verified = $null
        if (-not $ok) { $R.warnings.Add('Skipping reboot: services not healthy') }
    }
    $R.bootstrap_complete = ($R.platform_verified -and
                             ($R.services_healthy -eq $true) -and
                             ($R.scanner_device_detected -eq $true) -and
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
    $servicesOk = Test-Services -Result $R
    $scannerOk = Test-Scanner -Result $R
    if (-not $servicesOk -or -not $scannerOk) {
        $R.bootstrap_complete = $false
        $R.exit_code = 20
    }
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
    $scannerOk = Test-Scanner -Result $R
    $R.services_healthy    = $ok
    $R.bootstrap_complete  = ($ok -and $scannerOk)
    $R.exit_code = if ($R.bootstrap_complete) { 0 } else { 20 }
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

if ($PSCmdlet.ParameterSetName -eq 'ConfigureSshAccess') {
    Write-Host ''
    Write-Host 'Multimedica Scanner - Configure SSH Access' -ForegroundColor Cyan
    Write-Host "Target: $PiHost" -ForegroundColor Cyan
    Write-Host ''
    try { Invoke-ConfigureSshAccess; exit 0 }
    catch { Write-Fail $_.Exception.Message; exit 20 }
}

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
