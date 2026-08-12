<#
.SYNOPSIS
    Create a multimedica-installer.json file interactively.

.DESCRIPTION
    The installer configuration file holds only the QR authorization token.
    Cloud credentials (shared_secret, endpoint_url) must NOT be placed here.
    They arrive through the cloud_config QR during commissioning.

    File format:
        { "qr_admin_token": "<opaque-token>" }

    The token is an opaque exact byte sequence.
    Do not trim, normalize, case-fold, or remove accents.

.PARAMETER OutputPath
    Path to write the file.  Default: .\multimedica-installer.json

.NOTES
    Token rotation before first real-device commissioning:
      1. Generate a new random token.
      2. Deploy it as SCANNER_QR_ADMIN_TOKEN in the Cloud Function environment.
      3. Rebuild the React app with the new REACT_APP_SCANNER_QR_ADMIN_TOKEN.
      4. Run this script to capture the new value without echoing it.
      5. Distribute the resulting .json file to authorized field installers only.
      6. Never commit the file to source control.
#>

#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$OutputPath = '.\multimedica-installer.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host 'Multimedica Installer Configuration Creator' -ForegroundColor Cyan
Write-Host 'Input is not echoed for the secret token.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'NOTE: Cloud credentials are NOT entered here.' -ForegroundColor Yellow
Write-Host '      They arrive through the cloud_config QR during commissioning.' -ForegroundColor Yellow
Write-Host ''

# Read the QR admin token without echoing
$tokenSS = Read-Host 'QR administrator token (exact SCANNER_QR_ADMIN_TOKEN value)' -AsSecureString

# Decode to string in memory only; clear immediately after writing
$BSTR  = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSS)
$token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($BSTR)
[System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)

if ([string]::IsNullOrEmpty($token)) {
    throw 'QR administrator token must not be empty'
}

# Installer supplies only qr_admin_token (cloud credentials arrive via QR and are stored through validated secrets store)
$cfg  = [ordered]@{ qr_admin_token = $token }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    (Join-Path (Get-Location).Path $OutputPath),
    ($cfg | ConvertTo-Json),
    $utf8
)

# Clear sensitive data from memory
$token = $null; $cfg = $null; [System.GC]::Collect()

# Restrict file ACL to the current user only
try {
    $acl  = Get-Acl $OutputPath
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
        'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -Path $OutputPath -AclObject $acl
    Write-Host '    File ACL restricted to current user.' -ForegroundColor Green
} catch {
    Write-Warning "Could not restrict file ACL: $_"
}

Write-Host ''
Write-Host "Configuration saved to: $OutputPath" -ForegroundColor Green
Write-Host ''
Write-Host 'IMPORTANT:' -ForegroundColor Yellow
Write-Host '  - Keep this file secure. It contains the QR authorization token.'
Write-Host '  - Do not commit it to source control.'
Write-Host '  - Use it with: .\provision-scanner.ps1 -Install -PiHost <host>'
Write-Host ''