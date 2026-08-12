<#
.SYNOPSIS
    Query the current device state from a Pi running the Multimedica bootstrap.

.OUTPUTS
    PSCustomObject with commissioning state fields.
    Returns $null if the device cannot be reached or state cannot be parsed.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PiHost,
    [Parameter(Mandatory)][int]   $PiPort,
    [Parameter(Mandatory)][string]$SshExe
)

$SshCommon = @('-o','StrictHostKeyChecking=accept-new','-p',"$PiPort")

function _Remote { param([string]$Cmd)
    & $SshExe @SshCommon $PiHost $Cmd
    return $LASTEXITCODE }

$statusJson = & $SshExe @SshCommon $PiHost 'curl -fs http://127.0.0.1:3000/api/status 2>/dev/null || echo "{}"'
if ($LASTEXITCODE -ne 0) { return $null }

try {
    $state = $statusJson | ConvertFrom-Json
    return [PSCustomObject]@{
        commissioning_state    = $state.commissioning_state
        commissioning_complete = [bool]$state.commissioning_complete
        missing_fields         = $state.missing_fields
        config                 = $state.config
        services_healthy       = $true
    }
} catch {
    return $null
}
