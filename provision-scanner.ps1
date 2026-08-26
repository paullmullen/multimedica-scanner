<#
.SYNOPSIS
    Multimedica Scanner Bootstrap Provisioning Installer

.DESCRIPTION
    Mutually exclusive action modes:
        -Install                     Install the bootstrap layer (acceptance point A)
        -Verify                      Query and report current device state (read-only)
        -Commission                  Check commissioning acceptance point B
        -Repair                      Re-run bootstrap installation safely
        -InstallRelease              Install and promote a named release artifact
        -RollbackRelease             Reserved; currently returns RESULT: PARTIAL
        -UpdateDisplay               Atomically update bootstrap display assets
        -ValidateProductionCandidate Run specialized temporary hardware validation

    Utilities:
        -ConfigureSshAccess  Install and verify the workstation's dedicated
                             provisioning public key on the Pi
        -CreateInstallerConfig
                             Create the installer configuration interactively

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

    [Parameter(Mandatory, ParameterSetName = 'UpdateDisplay')]
    [switch]$UpdateDisplay,

    [Parameter(Mandatory, ParameterSetName = 'ConfigureSshAccess')]
    [switch]$ConfigureSshAccess,

    [Parameter(Mandatory, ParameterSetName = 'ValidateProductionCandidate')]
    [switch]$ValidateProductionCandidate,

    # Required in all SSH modes
    [Parameter(Mandatory, ParameterSetName = 'Install')]
    [Parameter(Mandatory, ParameterSetName = 'Verify')]
    [Parameter(Mandatory, ParameterSetName = 'Commission')]
    [Parameter(Mandatory, ParameterSetName = 'Repair')]
    [Parameter(Mandatory, ParameterSetName = 'InstallRelease')]
    [Parameter(Mandatory, ParameterSetName = 'RollbackRelease')]
    [Parameter(Mandatory, ParameterSetName = 'ConfigureSshAccess')]
    [Parameter(Mandatory, ParameterSetName = 'ValidateProductionCandidate')]
    [Parameter(Mandatory, ParameterSetName = 'UpdateDisplay')]
    [string]$PiHost,

    # ReleaseVersion: declared ONCE; required for release modes, optional for Commission
    [Parameter(Mandatory, ParameterSetName = 'InstallRelease')]
    [Parameter(Mandatory, ParameterSetName = 'RollbackRelease')]
    [Parameter(ParameterSetName = 'Commission')]
    [string]$ReleaseVersion,

    [Parameter(Mandatory, ParameterSetName = 'InstallRelease')]
    [ValidateScript({ if (-not (Test-Path -LiteralPath $_ -PathType Leaf)) { throw 'ArtifactPath must identify a regular local file.' }; $true })]
    [string]$ArtifactPath,

    [Parameter(Mandatory, ParameterSetName = 'InstallRelease')]
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$ArtifactSha256,

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
    [Parameter(ParameterSetName = 'ValidateProductionCandidate')]
    [Parameter(ParameterSetName = 'UpdateDisplay')]
    [int]$PiPort = 22,

    [Parameter(ParameterSetName = 'Install')]
    [Parameter(ParameterSetName = 'Verify')]
    [Parameter(ParameterSetName = 'Commission')]
    [Parameter(ParameterSetName = 'Repair')]
    [Parameter(ParameterSetName = 'InstallRelease')]
    [Parameter(ParameterSetName = 'RollbackRelease')]
    [Parameter(ParameterSetName = 'ValidateProductionCandidate')]
    [Parameter(ParameterSetName = 'UpdateDisplay')]
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
    return @{
        mode                    = $Mode
        timestamp               = (Get-Date -Format 'o')
        pi_host                 = $PiHostValue
        exit_code               = 1
        bootstrap_complete      = $false
        configuration_complete  = $false
        controller_configuration_complete = $null
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
        release_manager_installed = $null
        release_artifact_validator_installed = $null
        release_recovery_unit_installed = $null
        production_unit_installed = $null
        release_recovery_enabled = $null
        release_recovery_active = $null
        production_enabled = $null
        production_active = $null
        production_gate_present = $null
        current_release_present = $null
        install_operation_status = $null
        recovery_enabled_for_future_boots = $null
        candidate_health_passed = $null
        candidate_display_verified = $null
        operator_confirmed = $null
        promotion_completed = $null
        automatic_rollback = $null
        transaction_stage = $null
        display_update_status = $null
        display_rollback_performed = $null
        errors                  = [System.Collections.Generic.List[string]]::new()
        warnings                = [System.Collections.Generic.List[string]]::new()
    }
}

function Ensure-ProvisioningResult {
    param([hashtable]$Result, [string]$Mode, [string]$PiHostValue)

    if ($null -eq $Result) { throw 'Provisioning result hashtable is required.' }

    $defaults = New-ProvisioningResult $Mode $PiHostValue
    foreach ($key in $defaults.Keys) {
        $hasProperty = $Result.Contains($key)

        if (-not $hasProperty) {
            $Result[$key] = $defaults[$key]
        }
    }

    foreach ($listKey in @('errors', 'warnings')) {
        $value = $Result[$listKey]
        if ($null -eq $value) {
            $Result[$listKey] = [System.Collections.Generic.List[string]]::new()
        }
    }
}

function Get-OptionalPropertyValue {
    param([object]$Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Write-ProvisioningResult { param([hashtable]$Result)
    $out  = $Result | ConvertTo-Json -Depth 4
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $dest = if ([System.IO.Path]::IsPathRooted($ResultFile)) {
        [System.IO.Path]::GetFullPath($ResultFile)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $ResultFile))
    }
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
    if ($env:MULTIMEDICA_TEST_SSH_EXE -and $env:MULTIMEDICA_TEST_SCP_EXE) {
        if (-not (Test-Path -LiteralPath $env:MULTIMEDICA_TEST_SSH_EXE) -or -not (Test-Path -LiteralPath $env:MULTIMEDICA_TEST_SCP_EXE)) {
            throw 'Configured test SSH executable path does not exist.'
        }
        $script:SshExe = $env:MULTIMEDICA_TEST_SSH_EXE
        $script:ScpExe = $env:MULTIMEDICA_TEST_SCP_EXE
    } else {
        $cmd = Get-Command ssh.exe -EA SilentlyContinue
        if (-not $cmd) { $cmd = Get-Command ssh -EA SilentlyContinue }
        if (-not $cmd) { throw 'ssh not found. Install OpenSSH for Windows.' }
        $script:SshExe = $cmd.Source
        $cmd2 = Get-Command scp.exe -EA SilentlyContinue
        if (-not $cmd2) { $cmd2 = Get-Command scp -EA SilentlyContinue }
        if (-not $cmd2) { throw 'scp not found. Install OpenSSH for Windows.' }
        $script:ScpExe = $cmd2.Source
    }
    $identityArgs = @()
    if (Test-Path -LiteralPath $script:ProvisioningKey) {
        $identityArgs = @('-i', $script:ProvisioningKey, '-o', 'IdentitiesOnly=yes')
    }
    $transportBounds = @(
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2'
    )
    $script:SshCommon = @('-o', 'StrictHostKeyChecking=accept-new', '-p', "$Port") + $transportBounds + $identityArgs
    $script:ScpCommon = @('-o', 'StrictHostKeyChecking=accept-new', '-P', "$Port") + $transportBounds + $identityArgs
    if (-not $AllowPassword) {
        if (-not $identityArgs.Count) {
            throw 'Provisioning SSH key not found. Run: .\provision-scanner.ps1 -ConfigureSshAccess -PiHost <user@host>'
        }
        $testArgs = $script:SshCommon + @('-n', '-o', 'BatchMode=yes', $PiHost, 'true')
        $previousErrorAction = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $keyTestOutput = @(& $script:SshExe @testArgs 2>&1)
            $keyTestExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorAction
        }
        if ($keyTestExitCode -ne 0) {
            $keyTestText = ($keyTestOutput -join "`n")
            if ($keyTestText -match 'REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key') {
                throw 'SSH host key changed. Run -ConfigureSshAccess and answer yes to the re-imaged Pi question.'
            }
            throw 'Key-based SSH verification failed. Run: .\provision-scanner.ps1 -ConfigureSshAccess -PiHost <user@host>'
        }
        # All normal provisioning operations are non-interactive. Never fall
        # back to a password prompt after the dedicated key has been verified.
        # This prevents a prompt from appearing beneath an unrelated phase
        # heading and keeps password input out of captured diagnostic output.
        $script:SshCommon += @('-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0')
        $script:ScpCommon += @('-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0')
    }
    Write-Host "    SSH: $($script:SshExe)" -ForegroundColor DarkGray }

function Invoke-ConfigureSshAccess {
    $reimaged = Read-Host 'Was this Pi re-imaged since it was last used from this computer? Type lowercase yes or no'
    if ($reimaged -cne 'yes' -and $reimaged -cne 'no') {
        throw 'Re-image response must be exactly lowercase yes or no.'
    }
    if ($reimaged -ceq 'yes') {
        $keygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue
        if (-not $keygen) { $keygen = Get-Command ssh-keygen -ErrorAction SilentlyContinue }
        if (-not $keygen) { throw 'ssh-keygen not found. Install OpenSSH for Windows.' }
        $knownHost = ($PiHost -split '@')[-1]
        $knownHostLookup = if ($PiPort -eq 22) { $knownHost } else { "[$knownHost]:$PiPort" }
        Write-Phase "Removing the previous SSH host key for $knownHostLookup"
        & $keygen.Source -R $knownHostLookup
        if ($LASTEXITCODE -ne 0) {
            throw "Could not remove the previous SSH host key for $knownHostLookup"
        }
        Write-Ok 'Previous SSH host key removed; the new image will be verified on first connection'
    }

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

    $testArgs = $script:SshCommon + @('-n', '-o', 'BatchMode=yes', $PiHost, 'true')
    & $script:SshExe @testArgs
    if ($LASTEXITCODE -ne 0) { throw 'Provisioning public key was installed but verification failed.' }
    Write-Ok 'Key-based SSH verified; provisioning will not prompt for the Pi password'
}

# Run remote command; return exit code; stdout goes to console
function Invoke-Remote { param([string]$Desc, [string]$Cmd, [switch]$AllowFail, [switch]$Quiet)
    if ($Desc) { Write-Phase $Desc }
    $a = $script:SshCommon + @('-n', $PiHost, $Cmd)
    $previousErrorAction = $ErrorActionPreference
    try {
        # Windows PowerShell promotes native stderr to a terminating
        # NativeCommandError when the script-wide preference is Stop. Remote
        # reachability probes intentionally expect nonzero SSH exits.
        $ErrorActionPreference = 'Continue'
        $remoteOutput = @(& $script:SshExe @a 2>&1)
        $remoteExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    $script:LastRemoteOutput = @($remoteOutput)
    $script:LastRemoteExitCode = $remoteExitCode
    if (-not $Quiet) {
        foreach ($line in $remoteOutput) { Write-Host $line }
    }
    if (-not $AllowFail -and $remoteExitCode -ne 0) {
        $detail = ($remoteOutput | Where-Object { -not [string]::IsNullOrWhiteSpace("$_") } | Select-Object -Last 1)
        if ($detail) { throw "SSH command failed ($remoteExitCode): $Desc -- Remote: $detail" }
        throw "SSH command failed ($remoteExitCode): $Desc"
    }
    return $remoteExitCode }

# Run the one clean-image bootstrap command on an attached remote TTY.
# SSH authentication remains key-only because SshCommon retains BatchMode=yes;
# the TTY exists solely so remote sudo can read one hidden password directly
# from the operator. Neither the password nor command output is captured by
# PowerShell.
function Invoke-RemoteBootstrapSudo { param([string]$Desc, [string]$Cmd)
    Invoke-RemoteSudoTty -Desc $Desc -Cmd $Cmd -FailureLabel 'Interactive bootstrap command'
}

# Run a remote sudo command on an attached TTY so sudo reads the password
# directly from the operator. PowerShell never redirects or captures stdin,
# which prevents a password from entering diagnostic output or result files.
function Invoke-RemoteSudoTty { param(
    [string]$Desc,
    [string]$Cmd,
    [string]$FailureLabel = 'Interactive sudo command'
)
    if ($Desc) { Write-Phase $Desc }
    Write-Host '    At the sudo password prompt, type the Pi password once and press Enter.' -ForegroundColor Yellow
    Write-Host '    The password will not appear. After pressing Enter, wait; do not type it again.' -ForegroundColor Yellow
    $a = $script:SshCommon + @('-tt', $PiHost, $Cmd)
    & $script:SshExe @a
    $remoteExitCode = $LASTEXITCODE
    if ($remoteExitCode -ne 0) {
        throw "$FailureLabel failed ($remoteExitCode): $Desc"
    }
}

# Run remote command; capture and return stdout as string
function Invoke-RemoteCapture { param([string]$Desc, [string]$Cmd)
    if ($Desc) { Write-Phase $Desc }
    $a   = $script:SshCommon + @('-n', $PiHost, $Cmd)
    $out = & $script:SshExe @a 2>$null
    $script:LastRemoteCaptureExitCode = $LASTEXITCODE
    return ($out -join "`n")  }

function Invoke-InteractiveRemote { param([string]$Desc, [string[]]$Arguments, [string]$ArtifactRemotePath)
    if ($Desc) { Write-Phase $Desc }
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $script:SshExe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.Arguments = (($script:SshCommon + $Arguments) | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    if (-not $process.Start()) { throw 'Could not start attached release operation.' }
    $claimed = $false
    try {
        while (-not $process.StandardOutput.EndOfStream) {
            $line = $process.StandardOutput.ReadLine()
            if ($line -eq 'ARTIFACT_CLAIMED') { $claimed = $true; continue }
            if ($line -like '*Type lowercase yes to continue*') {
                $answer = Read-Host $line
                if ($answer -cne 'yes') { $process.StandardInput.WriteLine('no'); $process.StandardInput.Flush(); throw 'Operator confirmation must be exactly lowercase yes.' }
                $process.StandardInput.WriteLine('yes')
                $process.StandardInput.Flush()
            } else { Write-Host $line }
        }
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw 'Remote release operation failed.' }
        return @{ Claimed = $claimed; ExitCode = $process.ExitCode }
    } finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
        if (-not $claimed -and $ArtifactRemotePath) {
            Invoke-Remote '' "rm -f '$ArtifactRemotePath'" -AllowFail | Out-Null
        }
    }
}

function Test-PlatformPreflight { param([hashtable]$Result)
    $probeCommand = @'
export LC_ALL=C
model=$(tr -d '\0' </sys/firmware/devicetree/base/model 2>/dev/null || true)
. /etc/os-release
free_bytes=$(df -B1 --output=avail / 2>/dev/null | awk 'NR == 2 { print $1 }')
printf 'MM_MODEL=%s\n' "$model"
printf 'MM_ARCH=%s\n' "$(uname -m)"
printf 'MM_OS_ID=%s\n' "${ID:-}"
printf 'MM_OS_VERSION=%s\n' "${VERSION_ID:-}"
printf 'MM_OS_CODENAME=%s\n' "${VERSION_CODENAME:-}"
printf 'MM_FREE_BYTES=%s\n' "$free_bytes"
'@
    # Encode the probe to avoid Windows OpenSSH/CRT stripping embedded quotes
    # from the remote shell command and word-splitting values such as the model.
    $probeBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probeCommand))
    $probe = Invoke-RemoteCapture `
        'Checking qualified platform capabilities' `
        "printf %s $probeBase64 | base64 -d | bash"
    $values = @{}
    foreach ($line in @($probe -split "`n")) {
        if ($line -match '^MM_([A-Z_]+)=(.*)$') {
            $values[$Matches[1]] = $Matches[2].Trim()
        }
    }
    foreach ($required in @('MODEL', 'ARCH', 'OS_ID', 'OS_VERSION', 'OS_CODENAME', 'FREE_BYTES')) {
        if (-not $values.ContainsKey($required)) {
            throw "Platform probe did not return required field: MM_$required"
        }
    }

    $model = $values.MODEL
    $arch = $values.ARCH
    $osId = $values.OS_ID
    $osVersion = $values.OS_VERSION
    $osCodename = $values.OS_CODENAME
    [Int64]$freeBytes = 0
    if (-not [Int64]::TryParse($values.FREE_BYTES, [ref]$freeBytes)) {
        throw "Platform probe returned invalid free disk space: '$($values.FREE_BYTES)'"
    }

    if ($model -notmatch '^Raspberry Pi\b') { throw "Unsupported hardware: $model" }
    if ($arch -ne 'aarch64') { throw "Unsupported architecture: $arch" }
    if ($osId -ne 'debian' -or $osVersion.Split('.')[0] -ne '13' -or $osCodename -ne 'trixie') {
        throw "Unsupported OS: ID=$osId VERSION_ID=$osVersion VERSION_CODENAME=$osCodename"
    }
    if ($freeBytes -lt (8GB)) { throw 'At least 8 GiB free space on / is required.' }

    if ($model -match '^Raspberry Pi 4 Model B\b') {
        Write-Ok "Qualified platform: $model, Debian $osVersion ($osCodename), $arch"
    } else {
        $warning = "Compatible platform capabilities detected, but hardware is not yet physically qualified: $model"
        Write-Warn $warning
        $Result.warnings.Add($warning)
    }
    $Result.platform_verified = $true
    return $true
}

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
    Invoke-RemoteBootstrapSudo 'Running bootstrap installer' "sudo -p 'Pi sudo password: ' bash $tmp/bootstrap/install-bootstrap.sh --src $tmp/bootstrap --secrets $stRemote $ff 2>&1" }

# ---------------------------------------------------------------------------
# Release infrastructure status (read-only, non-secret)
# ---------------------------------------------------------------------------

function Test-ReleaseInfrastructure { param([hashtable]$Result)
        $probe = @'
release_manager_installed=0
release_artifact_validator_installed=0
release_recovery_unit_installed=0
production_unit_installed=0
release_recovery_enabled=0
release_recovery_active=0
production_enabled=0
production_active=0
production_gate_present=0
current_release_present=0
state_valid=1
contradiction=0

test -f /opt/multimedica-scanner/bootstrap/lib/release-manager.js && release_manager_installed=1
test -f /opt/multimedica-scanner/bootstrap/lib/release-artifact.js && release_artifact_validator_installed=1
test -f /etc/systemd/system/multimedica-release-recovery.service && release_recovery_unit_installed=1
test -f /etc/systemd/system/multimedica-production.service && production_unit_installed=1
systemctl is-enabled --quiet multimedica-release-recovery.service && release_recovery_enabled=1
systemctl is-active --quiet multimedica-release-recovery.service && release_recovery_active=1
systemctl is-enabled --quiet multimedica-production.service && production_enabled=1
systemctl is-active --quiet multimedica-production.service && production_active=1
test -e /run/multimedica-scanner/production-allowed && production_gate_present=1
if [ -d /opt/multimedica-scanner/current ] || [ -L /opt/multimedica-scanner/current ]; then
    target=$(readlink -f /opt/multimedica-scanner/current 2>/dev/null || true)
    case "$target" in
        /opt/multimedica-scanner/releases/*) current_release_present=1 ;;
    esac
fi
if [ -f /var/lib/multimedica-scanner/state/installed-version.json ]; then
    node - <<'NODE' >/dev/null 2>&1 || state_valid=0
const fs = require('fs');
const root = '/opt/multimedica-scanner/releases/';
const r = JSON.parse(fs.readFileSync('/var/lib/multimedica-scanner/state/installed-version.json', 'utf8'));
const safe = (v) => typeof v === 'string' && v.startsWith(root) && !v.includes('..');
if ((r.current_version || r.last_known_good_version) && (!safe(r.current_dir) || !safe(r.last_known_good_dir))) process.exit(1);
NODE
fi
if [ "$production_gate_present" -eq 1 ] && [ "$current_release_present" -eq 0 ]; then contradiction=1; fi
if [ "$production_active" -eq 1 ] && [ "$current_release_present" -eq 0 ]; then contradiction=1; fi
if [ "$release_recovery_active" -eq 1 ] && [ "$current_release_present" -eq 0 ]; then contradiction=1; fi
printf 'MM_RELEASE_MANAGER=%s\n' "$release_manager_installed"
printf 'MM_RELEASE_ARTIFACT=%s\n' "$release_artifact_validator_installed"
printf 'MM_RELEASE_UNIT=%s\n' "$release_recovery_unit_installed"
printf 'MM_PRODUCTION_UNIT=%s\n' "$production_unit_installed"
printf 'MM_RELEASE_ENABLED=%s\n' "$release_recovery_enabled"
printf 'MM_RELEASE_ACTIVE=%s\n' "$release_recovery_active"
printf 'MM_PRODUCTION_ENABLED=%s\n' "$production_enabled"
printf 'MM_PRODUCTION_ACTIVE=%s\n' "$production_active"
printf 'MM_GATE=%s\n' "$production_gate_present"
printf 'MM_CURRENT=%s\n' "$current_release_present"
printf 'MM_STATE_VALID=%s\n' "$state_valid"
printf 'MM_CONTRADICTION=%s\n' "$contradiction"
'@
        $out = Invoke-RemoteCapture 'Checking release infrastructure state' "printf %s '$([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe)))' | base64 -d | bash"
        if ($script:LastRemoteCaptureExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($out)) {
                $Result.warnings.Add('Release infrastructure status unavailable')
                return $false
        }
        $values = @{}
        foreach ($line in @($out -split "`n")) {
                if ($line -match '^MM_([A-Z_]+)=(0|1)$') { $values[$Matches[1]] = ($Matches[2] -eq '1') }
        }
        $Result.release_manager_installed = $values['RELEASE_MANAGER']
        $Result.release_artifact_validator_installed = $values['RELEASE_ARTIFACT']
        $Result.release_recovery_unit_installed = $values['RELEASE_UNIT']
        $Result.production_unit_installed = $values['PRODUCTION_UNIT']
        $Result.release_recovery_enabled = $values['RELEASE_ENABLED']
        $Result.release_recovery_active = $values['RELEASE_ACTIVE']
        $Result.production_enabled = $values['PRODUCTION_ENABLED']
        $Result.production_active = $values['PRODUCTION_ACTIVE']
        $Result.production_gate_present = $values['GATE']
        $Result.current_release_present = $values['CURRENT']
        if ($values['STATE_VALID'] -eq $false -or $values['CONTRADICTION'] -eq $true) {
                $Result.errors.Add('Release infrastructure state is unsafe or malformed')
                return $false
        }
        return $true
}

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
    # Check display health via bounded retries. A service restart can accept a
    # connection during startup without completing the response immediately.
    $rc = 1
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        $rc = Invoke-Remote '' 'curl -fs --connect-timeout 3 --max-time 8 http://127.0.0.1:3001/api/health -o /dev/null 2>/dev/null' -AllowFail -Quiet
        if ($rc -eq 0) { break }
        Start-Sleep -Seconds 2
    }
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
    Write-Phase 'Rebooting Pi (no operator input required)'
    Invoke-Remote '' 'sudo -n /usr/local/sbin/multimedica-reboot' -AllowFail | Out-Null
    Write-Host '    The Pi will disconnect temporarily. Do not type a password or scan a QR code.'
    Write-Host '    Waiting for the current system to go offline...'
    Start-Sleep -Seconds 2
    $wentOffline = $false
    for ($i = 1; $i -le 15; $i++) {
        $rc = Invoke-Remote '' 'echo ok' -AllowFail -Quiet
        if ($rc -ne 0) { $wentOffline = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $wentOffline) {
        $Result.errors.Add('Pi did not go offline after reboot request')
        return $false
    }
    Write-Ok 'Pi went offline'
    Write-Host '    Waiting for the rebooted Pi to reconnect...'
    for ($i = 1; $i -le 18; $i++) {
        $rc = Invoke-Remote '' 'echo ok' -AllowFail -Quiet
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
    Test-PlatformPreflight -Result $R | Out-Null
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
}

# ---------------------------------------------------------------------------
# Mode: -Verify
# ---------------------------------------------------------------------------

function Get-ControllerDeviceStatus {
    $statusJson = Invoke-RemoteCapture 'Querying device state' 'curl -fs --connect-timeout 3 --max-time 8 http://127.0.0.1:3000/api/status 2>/dev/null'
    $exitCode = $script:LastRemoteCaptureExitCode
    $responseLength = if ($null -eq $statusJson) { 0 } else { $statusJson.Length }
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($statusJson)) {
        return [PSCustomObject]@{
            IsValid = $false
            Diagnostic = "SSH/controller status query failed (exit $exitCode; response length $responseLength)"
        }
    }
    try {
        $obj = $statusJson | ConvertFrom-Json
        $rawConfigurationComplete = Get-OptionalPropertyValue -Object $obj -Name 'configuration_complete'
        if ($rawConfigurationComplete -isnot [bool]) {
            return [PSCustomObject]@{
                IsValid = $false
                Diagnostic = "Controller status response was malformed (response length $responseLength)"
            }
        }
        return [PSCustomObject]@{
            IsValid = $true
            State = Get-OptionalPropertyValue -Object $obj -Name 'commissioning_state'
            ConfigurationComplete = $rawConfigurationComplete
            CommissioningComplete = (Get-OptionalPropertyValue -Object $obj -Name 'commissioning_complete' $false) -eq $true
            ReleaseInstalled = (Get-OptionalPropertyValue -Object $obj -Name 'release_installed' $false) -eq $true
            ProductionReady = (Get-OptionalPropertyValue -Object $obj -Name 'production_ready' $false) -eq $true
        }
    } catch {
        return [PSCustomObject]@{
            IsValid = $false
            Diagnostic = "Controller status response was malformed (response length $responseLength)"
        }
    }
}

function Invoke-Verify { param([hashtable]$R)
    Ensure-ProvisioningResult -Result $R -Mode $PSCmdlet.ParameterSetName -PiHostValue $PiHost
    Initialize-Ssh $PiPort
    $status = Get-ControllerDeviceStatus
    if ($status.IsValid) {
        $R.bootstrap_complete       = ($null -ne $status.State)
        $R.configuration_complete   = $status.ConfigurationComplete
        $R.controller_configuration_complete = $status.ConfigurationComplete
        $R.commissioning_complete   = $status.CommissioningComplete
        $R.release_installed        = $status.ReleaseInstalled
        $R.production_ready         = $status.ProductionReady
        Write-Ok "State: $($status.State) | Config complete: $($status.ConfigurationComplete)"
        $R.exit_code = 0
    } else {
        Write-Warn 'Could not parse device status (controller may not be running)'
        $R.warnings.Add("$($status.Diagnostic); device status unparseable")
        $R.exit_code = 10
    }
    $releaseStateOk = Test-ReleaseInfrastructure -Result $R
    $servicesOk = Test-Services -Result $R
    $scannerOk = Test-Scanner -Result $R
    if (-not $servicesOk -or -not $scannerOk -or -not $releaseStateOk) {
        $R.bootstrap_complete = $false
        $R.exit_code = 20
    }
    return }

# ---------------------------------------------------------------------------
# Mode: -Repair
# ---------------------------------------------------------------------------

function Invoke-Repair { param([hashtable]$R)
    Initialize-Ssh $PiPort
    $cfg = Read-InstallerConfig $InstallerConfig
    Write-Redacted 'qr_admin_token'
    Test-PlatformPreflight -Result $R | Out-Null
    Install-Bootstrap -Result $R -Cfg $cfg -IsRepair
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
    $R.bootstrap_complete = (($R.services_healthy -eq $true) -and
                             ($R.scanner_device_detected -eq $true) -and
                             ($R.reboot_verified -ne $false))
    $R.exit_code = if ($R.bootstrap_complete) { 0 } else { 20 }
}

# ---------------------------------------------------------------------------
# Mode: -InstallRelease
# ---------------------------------------------------------------------------

function Invoke-InstallRelease { param([hashtable]$R)
    if ($ReleaseVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw 'ReleaseVersion must be semantic.' }
    if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) { throw 'ArtifactPath must identify a regular local file.' }
    $localHash = (Get-FileHash -LiteralPath $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($localHash -ne $ArtifactSha256.ToLowerInvariant()) { throw 'ArtifactSha256 does not match the local artifact.' }

    Initialize-Ssh $PiPort
    $artifactName = "install-$([Guid]::NewGuid().ToString('N')).tgz"
    $remoteRoot = '/var/lib/multimedica-scanner/release-transfer'
    $remoteArtifact = "$remoteRoot/$artifactName"
    $remoteArtifactDestination = "$PiHost`:$remoteArtifact"
    $copyArgs = $script:ScpCommon + @($ArtifactPath, $remoteArtifactDestination)
    & $script:ScpExe @copyArgs 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'SCP artifact transfer failed.' }

    $wrapper = '/usr/local/sbin/multimedica-release-install'
    $operationCommand = "sudo -n $wrapper --version '$ReleaseVersion' --artifact-name '$artifactName' --sha256 '$($ArtifactSha256.ToLowerInvariant())'"
    $R.install_operation_status = 'attached'
    $R.release_version = $ReleaseVersion
    $result = Invoke-InteractiveRemote 'Running attached release operation' @($PiHost, $operationCommand) $remoteArtifact
    $R.operator_confirmed = $true
    $R.candidate_health_passed = $true
    $R.candidate_display_verified = $true
    $R.promotion_completed = $true
    $R.install_operation_status = 'complete'
    $R.transaction_stage = 'complete'
    $R.release_installed = $true
    $R.production_healthy = $true
    $R.exit_code = 0
    return $R
}

# ---------------------------------------------------------------------------
# Mode: -UpdateDisplay
# ---------------------------------------------------------------------------

function Invoke-UpdateDisplay { param([hashtable]$R)
    Initialize-Ssh $PiPort
    Test-PlatformPreflight -Result $R | Out-Null
    $project = (Get-Location).Path
    $public = Join-Path $project 'bootstrap\public'
    $updater = Join-Path $project 'bootstrap\display-update.js'
    $allowlist = @('app.js', 'full_logo.png', 'index.html', 'styles.css', 'start-kiosk.sh')
    if (-not (Test-Path -LiteralPath $updater -PathType Leaf)) { throw 'Display updater source is missing.' }
    $manifestFiles = @()
    foreach ($name in $allowlist) {
        $file = if ($name -eq 'start-kiosk.sh') { Join-Path $project 'bootstrap\start-kiosk.sh' } else { Join-Path $public $name }
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required display asset is missing: $name" }
        $item = Get-Item -LiteralPath $file
        $manifestFiles += [ordered]@{
            name = $name
            sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
            size = [Int64]$item.Length
        }
    }
    $manifestLocal = [System.IO.Path]::GetTempFileName()
    $remote = "/tmp/mm-display-update-$([Guid]::NewGuid().ToString('N'))"
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $manifest = [ordered]@{ version = 1; files = $manifestFiles } | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($manifestLocal, $manifest, $utf8)
        $null = Invoke-Remote 'Preparing display update staging' "umask 077; mkdir -p $remote/bundle"
        Copy-ToRemote 'Copying display updater' $updater "$remote/display-update.js"
        Copy-ToRemote 'Copying display manifest' $manifestLocal "$remote/bundle/manifest.json"
        foreach ($name in $allowlist) {
            $sourceFile = if ($name -eq 'start-kiosk.sh') { Join-Path $project 'bootstrap\start-kiosk.sh' } else { Join-Path $public $name }
            Copy-ToRemote "Copying display asset $name" $sourceFile "$remote/bundle/$name"
        }
        $R.install_operation_status = 'attached'
        $R.display_update_status = 'installing'
        try {
            Invoke-RemoteSudoTty `
                -Desc 'Installing display update' `
                -Cmd "sudo /usr/bin/node $remote/display-update.js --source $remote/bundle" `
                -FailureLabel 'Remote display update'
        } catch {
            # The updater emits rollback details directly to the attached TTY.
            # Do not capture or infer them because the same channel carries the
            # hidden sudo-password conversation.
            $R.display_rollback_performed = $null
            $R.display_update_status = 'failed'
            $R.install_operation_status = 'failed'
            throw
        }
        $R.display_update_status = 'complete'
        $R.display_rollback_performed = $false
        $R.install_operation_status = 'complete'
        $R.services_healthy = $true
        $R.exit_code = 0
    } finally {
        if (Test-Path -LiteralPath $manifestLocal) { Remove-Item -Force $manifestLocal }
        Invoke-Remote '' "rm -rf $remote" -AllowFail | Out-Null
    }
    return $R
}

# ---------------------------------------------------------------------------
# Mode: -Commission (stub; full implementation in Milestone 5)
# ---------------------------------------------------------------------------

function Invoke-Commission { param([hashtable]$R)
    Initialize-Ssh $PiPort
    Invoke-Verify -R $R | Out-Null
    if (-not $R.commissioning_complete) {
        $R.warnings.Add('Release installation not yet implemented (Milestone 5)')
        if ($R.exit_code -eq 0) { $R.exit_code = 10 }
    }
    return $R }

# ---------------------------------------------------------------------------
# Mode: -ValidateProductionCandidate (Milestone 4 hardware validation only)
# ---------------------------------------------------------------------------

function Test-EvtestControllerOwnership { param([hashtable]$R)
    $probe = @'
controller_pid=$(systemctl show -p MainPID --value multimedica-controller.service)
all=$(pgrep -u multimedica_edge -x evtest || true)
child=$(pgrep -P "$controller_pid" -x evtest || true)
all_count=$(printf '%s\n' "$all" | sed '/^$/d' | wc -l | tr -d ' ')
child_count=$(printf '%s\n' "$child" | sed '/^$/d' | wc -l | tr -d ' ')
printf 'MM_EVTEST_ALL=%s\n' "$all_count"
printf 'MM_EVTEST_CHILD=%s\n' "$child_count"
'@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe))
    $out = Invoke-RemoteCapture 'Verifying controller owns the only evtest reader' "printf %s $encoded | base64 -d | bash"
    $all = 0; $child = 0
    foreach ($line in ($out -split "`n")) {
        if ($line -match '^MM_EVTEST_ALL=(\d+)$') { $all = [int]$Matches[1] }
        if ($line -match '^MM_EVTEST_CHILD=(\d+)$') { $child = [int]$Matches[1] }
    }
    if ($all -ne 1 -or $child -ne 1) {
        $R.errors.Add('Expected exactly one evtest process owned by multimedica-controller.service')
        throw 'Controller does not exclusively own evtest.'
    }
    Write-Ok 'Only multimedica-controller.service owns evtest'
}

function Start-ProductionCandidate {
    param([string]$CandidateDir)
    $command = "set -e; sudo -u multimedica_edge env MULTIMEDICA_STATE_DIR=/var/lib/multimedica-scanner/state NODE_PATH=/opt/multimedica-scanner/node_modules PRODUCTION_PORT=3002 nohup /usr/bin/node $CandidateDir/production/scan-server.js >$CandidateDir/production.log 2>&1 & echo `$!"
    $pidText = Invoke-RemoteCapture 'Starting temporary production candidate on port 3002' $command
    $candidateProcessId = ($pidText -split "`n" | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1)
    if (-not $candidateProcessId) { throw 'Production candidate did not return a process identifier.' }
    return $candidateProcessId
}

function Wait-ProductionCandidateHealthy {
    param([hashtable]$R, [string]$CandidateDir)
    $lastStatusLength = 0
    for ($i = 1; $i -le 10; $i++) {
        $status = Invoke-RemoteCapture '' 'curl -fs --connect-timeout 3 --max-time 8 http://127.0.0.1:3002/api/status 2>/dev/null || true'
        $lastStatusLength = if ($null -eq $status) { 0 } else { $status.Length }
        try {
            $obj = $status | ConvertFrom-Json
            if ($obj.service -eq 'multimedica-production' -and $obj.state -eq 'healthy') {
                $R.production_healthy = $true
                Write-Ok 'Temporary production candidate healthy on port 3002'
                return
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    $R.production_healthy = $false
    $probe = Invoke-RemoteCapture '' "entrypoint=0; process=0; test -f '$CandidateDir/production/scan-server.js' && entrypoint=1; pgrep -f '$CandidateDir/production/scan-server.js' >/dev/null 2>&1 && process=1; printf 'MM_ENTRYPOINT=%s MM_PROCESS=%s' \"`$entrypoint\" \"`$process\""
    $entrypointPresent = $probe -match 'MM_ENTRYPOINT=1'
    $processRunning = $probe -match 'MM_PROCESS=1'
    throw "Temporary production candidate did not become healthy (entrypoint present: $entrypointPresent; process running: $processRunning; health response length: $lastStatusLength)."
}

function Stop-ProductionCandidate {
    param([string]$CandidateDir, [string]$CandidateProcessId, [switch]$RemoveFiles)
    if (-not $CandidateDir) { return }
    $safePid = if ($CandidateProcessId -match '^\d+$') { $CandidateProcessId } else { '' }
    $cleanup = if ($RemoveFiles) { "rm -rf '$CandidateDir';" } else { '' }
    $command = "set +e; if [ -n '$safePid' ]; then kill $safePid 2>/dev/null || true; fi; pkill -f '$CandidateDir/production/scan-server.js' 2>/dev/null || true; $cleanup exit 0"
    $label = if ($RemoveFiles) { 'Stopping and removing temporary production candidate' } else { 'Stopping temporary production candidate' }
    $null = Invoke-Remote $label $command -AllowFail
}

function Confirm-HardwareObservation {
    param([string]$Prompt)
    $answer = Read-Host "$Prompt Type yes to continue"
    if ($answer -cne 'yes') { throw 'Hardware observation was not explicitly confirmed.' }
}

function Test-SyntheticRuntimeDisplay {
    param([hashtable]$R)
    $stateId = if ($env:MULTIMEDICA_TEST_SSH_EXE -and $env:MULTIMEDICA_TEST_STATE_ID) {
        $env:MULTIMEDICA_TEST_STATE_ID
    } else {
        'candidate-display-' + [Guid]::NewGuid().ToString('N')
    }
    $payload = "{`"kind`":`"room`",`"state_id`":`"$stateId`",`"priority`":`"room`",`"display`":{`"mode`":`"room_status`",`"status`":{`"code`":`"available`",`"label`":`"CANDIDATE`"}}}"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $post = Invoke-RemoteCapture 'Posting synthetic candidate state through controller' "printf %s $encoded | base64 -d | curl -fsS --connect-timeout 3 --max-time 10 -X POST http://127.0.0.1:3000/api/runtime-state -H 'Content-Type: application/json' --data-binary @-"
    if ($post -notmatch '"ok"\s*:\s*true') { throw 'Controller rejected synthetic candidate display state.' }
    $display = Invoke-RemoteCapture 'Verifying synthetic state on display endpoint' 'curl -fsS --connect-timeout 3 --max-time 8 http://127.0.0.1:3001/api/state'
    if ($display -notmatch [Regex]::Escape($stateId)) { throw 'Synthetic candidate display state was not visible through the display-state endpoint.' }
    $R.warnings.Add("Slice 1 synthetic display state observed: $stateId")
    Confirm-HardwareObservation -Prompt 'Confirm the physical display showed the CANDIDATO state.'
}

function Invoke-ValidateProductionCandidate { param([hashtable]$R)
    Ensure-ProvisioningResult -Result $R -Mode 'ValidateProductionCandidate' -PiHostValue $PiHost
    Invoke-Verify -R $R | Out-Null
    if (($R['controller_configuration_complete'] -isnot [bool]) -or ($R['controller_configuration_complete'] -ne $true)) {
        throw 'Production candidate validation requires completed Wi-Fi, Station, and Cloud configuration.'
    }

    $active = Invoke-Remote '' 'systemctl is-active --quiet multimedica-production.service' -AllowFail
    if ($active -eq 0) {
        throw 'multimedica-production.service is already active; validation will not modify or stop it.'
    }

    $candidate = '/tmp/mm-production-candidate-' + [Guid]::NewGuid().ToString('N')
    $candidatePid = ''
    try {
        $null = Invoke-Remote 'Preparing temporary production candidate directory' "mkdir -p $candidate/bootstrap"
        $project = (Get-Location).Path
        Copy-DirToRemote 'Staging production scan server' "$project\production" $candidate
        Copy-DirToRemote 'Staging production configuration libraries' "$project\bootstrap\lib" "$candidate/bootstrap"
        Copy-DirToRemote 'Staging production schemas' "$project\schemas" $candidate

        $candidatePid = Start-ProductionCandidate -CandidateDir $candidate
        Wait-ProductionCandidateHealthy -R $R -CandidateDir $candidate
        Test-EvtestControllerOwnership -R $R
        Test-SyntheticRuntimeDisplay -R $R

        Confirm-HardwareObservation -Prompt 'Scan one real patient barcode and confirm the clinic workflow response.'

        Stop-ProductionCandidate -CandidateDir $candidate -CandidateProcessId $candidatePid
        $candidatePid = ''
        Confirm-HardwareObservation -Prompt 'Candidate stopped. Scan a test barcode and confirm production unavailable feedback.'

        $candidatePid = Start-ProductionCandidate -CandidateDir $candidate
        Wait-ProductionCandidateHealthy -R $R -CandidateDir $candidate
        Confirm-HardwareObservation -Prompt 'Disconnect and reconnect the USB scanner, then confirm recovery.'
        Test-EvtestControllerOwnership -R $R

        $R.warnings.Add('Production candidate validated temporarily; it was not enabled or promoted.')
        $R.exit_code = 0
        return
    } finally {
        Stop-ProductionCandidate -CandidateDir $candidate -CandidateProcessId $candidatePid -RemoveFiles
    }
}

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
        'Install'         { Invoke-Install     -R $result }
        'Verify'          { Invoke-Verify      -R $result | Out-Null }
        'Commission'      { Invoke-Commission  -R $result | Out-Null }
        'Repair'          { Invoke-Repair      -R $result }
        'InstallRelease'  { Invoke-InstallRelease -R $result | Out-Null }
        'UpdateDisplay'   { Invoke-UpdateDisplay -R $result | Out-Null }
        'ValidateProductionCandidate' { Invoke-ValidateProductionCandidate -R $result | Out-Null }
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
