# Manual Acceptance Procedure - Multimedica Scanner Bootstrap and Commissioning

## Purpose and Scope

This is the authoritative clean-device acceptance path for the Milestone 2
bootstrap and QR commissioning work, including the platform qualification added
in Milestone 3. It uses `provision-scanner.ps1` for platform preflight, SSH
setup, installer configuration, transfer, installation, verification, and
repair.

Run it on each newly imaged acceptance unit. It does not deploy production
software or enable `multimedica-production.service`. A run passes only after
the final power-cycle and verification steps succeed on the target hardware.

Source anchors:

- `provision-scanner.ps1`
- `provision/powershell/Invoke-BootstrapInstall.ps1`
- `bootstrap/install-bootstrap.sh`
- `bootstrap/controller.js`
- `bootstrap/display-server.js`
- `bootstrap/lib/scanner-reader.js`
- `bootstrap/lib/commissioning.js`
- `bootstrap/lib/platform-check.js`
- `docs/bootstrap-architecture.md`

## Hardware and Software Prerequisites

Use a newly reflashed Pi. Do not use an existing production scanner for this
procedure.

- A 64-bit Raspberry Pi meeting the platform capability checks. Raspberry Pi
  4B is the physically qualified baseline; a later Pi model is not rejected
  solely because its model number differs, but must be recorded as compatible
  and not yet physically qualified.
- Raspberry Pi OS Lite 64-bit, Debian 13 (Trixie), qualified image dated
  2026-06-18 as specified below
- 16GB or larger Class 10 microSD card
- HDMI-compatible display
- USB keyboard-wedge barcode scanner; the known working example is a BF SCAN
  USB scanner
- Suitable Pi power supply
- Ethernet cable
- Windows computer with PowerShell 5.1+, OpenSSH `ssh`/`scp`, Firebase CLI,
  and access to the project
- Initial Ethernet connection to the Pi with Debian package-repository access
- SSH enabled during imaging
- A configurable Pi username, password, and hostname; this procedure never
  assumes the username is `pi`

The Waveshare 4.3 HDMI LCD is the qualified display baseline. The observed mode
is HDMI-1 at 480x800 portrait. Enclosure-specific mounting and cable routing
remain device-integration details and must follow the display manufacturer's
instructions.

### Prepare downloaded installer files on Windows

Windows may attach a Mark-of-the-Web security marker to files downloaded through
a browser. If a ZIP archive is extracted while that marker is present,
PowerShell may refuse to run `provision-scanner.ps1` with a "not digitally
signed" error before the script can perform any automatic setup.

When the repository package was downloaded as a ZIP, unblock the ZIP **before**
extracting it:

```powershell
Unblock-File -LiteralPath .\milestone-3-platform-qualification.zip

Expand-Archive `
  -LiteralPath .\milestone-3-platform-qualification.zip `
  -DestinationPath C:\dev\multimedica-scanner `
  -Force
```

If the ZIP was already extracted, unblock the PowerShell scripts from the
repository root:

```powershell
Get-ChildItem -Path . -Recurse -File -Include *.ps1,*.psm1 |
  Unblock-File
```

This step removes only the downloaded-file marker. Do not change the
machine-wide PowerShell execution policy and do not use
`-ExecutionPolicy Bypass`. A normal `git clone` or `git pull` generally does not
carry the browser download marker, so this step may have no effect in a
Git-based checkout.

Leave Wi-Fi unconfigured during imaging. Use Ethernet for the initial SSH and
installer connection. On a clean image, `install-bootstrap.sh` uses `apt-get`
to install missing bootstrap prerequisites (`nodejs`, `npm`, `rsync`, `curl`,
`sudo`, `evtest`, Xorg/xinit, Chromium, `xset`, and `unclutter`) before installing the
application. Do not disconnect Ethernet until bootstrap installation is
complete.

## Exact OS Imaging Settings

Use Raspberry Pi Imager or the approved imaging tool with this qualified image:

| Field          | Qualified value                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Distribution   | Raspberry Pi OS Lite 64-bit; Debian 13 (Trixie)                                                                                         |
| Image filename | `2026-06-18-raspios-trixie-arm64-lite.img.xz`                                                                                           |
| Image URL      | `https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-06-19/2026-06-18-raspios-trixie-arm64-lite.img.xz` |
| SHA-256        | `acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3`                                                                      |
| Image build    | Raspberry Pi reference 2026-06-18, pi-gen `ca8aeed0ae300c2a89f55ce9617d5f96a27e99e5`, stage2                                            |

Verify the downloaded image before writing it:

```powershell
(Get-FileHash `
  -LiteralPath .\2026-06-18-raspios-trixie-arm64-lite.img.xz `
  -Algorithm SHA256).Hash.ToLower()
```

The result must exactly match the SHA-256 above. Configure, before first boot:

- Raspberry Pi OS Lite 64-bit using the qualified Trixie image
- A unique hostname
- A known non-default username and a recorded initial password
- SSH enabled with password authentication
- Ethernet available at first boot
- Wi-Fi not configured

Keep these three identifiers distinct:

| Identifier | Meaning                              | Example from the first scanner |
| ---------- | ------------------------------------ | ------------------------------ |
| Hostname   | The Pi's network/device name         | `MultimedicaScanner1`          |
| Username   | The Linux account used for SSH       | `multimedica_edge`             |
| IP address | The current address assigned by DHCP | `192.168.2.197`                |

The hostname is not the SSH username. Record the hostname and username in the
acceptance evidence. Retain the password in the approved credential store; do
not put it in this manual or in acceptance evidence.

Record the image filename, image date, URL, and verified SHA-256 in the evidence
table. A newer image may be evaluated separately, but it is not the qualified
baseline merely because it also reports Debian 13.

## Identify the Pi and Verify SSH Before Provisioning

After the Pi boots, use the router's DHCP-client list to confirm the Pi's
hostname, current IP address, and device identity. The display may also show the
hostname at its login prompt. A line such as `MultimedicaScanner1 login:` shows
the hostname; it does not reveal the username.

Use the confirmed IP address for initial provisioning if hostname resolution is
missing or stale. From Windows PowerShell, first test network reachability:

```powershell
ping <pi-ip-address>
```

Successful replies must come from the Pi's address. `Destination host
unreachable` is a failure even if the Windows packet summary reports zero lost
packets.

If SSH reports `REMOTE HOST IDENTIFICATION HAS CHANGED` after an expected
reflash, first reconfirm the Pi and IP address in the router and on the display.
Then remove only that obsolete local host-key entry and reconnect:

```powershell
ssh-keygen -R <pi-ip-address>
ssh <pi-user>@<pi-ip-address>
```

Accept the new key only when the changed identity is expected because of the
reflash and the IP address has been independently confirmed as this Pi.

Enter the recorded password. Password entry is intentionally not echoed. A
successful interactive SSH login is a mandatory prerequisite to `-Install`.
Run `exit` to return to PowerShell after confirming the login. If authentication
fails, verify the recorded username and password; do not confuse either one
with the hostname, and do not proceed to provisioning.

### Required Step: Configure SSH access on every newly imaged Pi

The installer starts multiple independent `ssh` and `scp` processes. Use its
supported SSH setup utility before any operational mode. This command is
required for **each newly imaged Pi**, even when the dedicated private key
already exists on the Windows workstation. An existing workstation key does not
mean its public key has been installed on the new Pi.

```powershell
.\provision-scanner.ps1 `
  -ConfigureSshAccess `
  -PiHost <pi-user>@<pi-ip-address>
```

The utility creates a dedicated workstation key at
`%USERPROFILE%\.ssh\multimedica_scanner_ed25519` if needed, asks for the Pi
password once, installs only its public key on the Pi, and verifies
noninteractive SSH. The private key remains on the Windows workstation. Do not
run `-Install` unless the utility reports `Key-based SSH verified` and exits
with code `0`. Operational modes fail before transferring files if this key is
missing or rejected.

## Physical Assembly

With all equipment powered off:

1. Insert the imaged microSD card into the Pi.
2. Connect the HDMI display to the Pi and power the display as specified by its
   manufacturer. Do not assume the HDMI cable also powers the display.
3. Connect the USB keyboard-wedge barcode scanner directly to a Pi USB port.
4. Connect Ethernet for initial package installation and provisioning.
5. Apply the Pi's USB-C power last.

Record the Pi model, display model, HDMI/power cable arrangement, scanner model,
and power-supply rating. The qualified baseline is a Pi 4B with a Waveshare 4.3
HDMI LCD at 480x800 portrait and a BF SCAN `9901:0301` scanner. Other compatible
hardware must still pass the capability and physical checks in this procedure.

## Predeployment Backend and Hosting Checks

The backend generator is the Firebase function `generateScannerCloudQr` in the
`api` codebase. The backend requires Firebase Authentication and
`users/{uid}.permissions.settings === true`.

The project administrator may run the approved metadata checks without recording
or displaying secret values:

```powershell
firebase functions:secrets:get SCANNER_QR_ADMIN_TOKEN --project alfarero-478ad
firebase functions:secrets:get SCANNER_SHARED_SECRET --project alfarero-478ad
```

Do not paste command output into the acceptance record. Do not use these commands
to copy a secret into a file. The installer obtains the token through the
PowerShell workflow below.

The frontend must contain no `REACT_APP_SCANNER_QR_ADMIN_TOKEN`. Cloud, Station,
and Wi-Fi QR generation occurs through the authenticated backend. Show Identity
is generated locally and has no `auth` object.

Deploy the current function and Hosting build before acceptance when either has
changed. Sign in as a user with `permissions.settings`, hard-refresh the admin
page, and generate fresh QRs. Do not reuse QRs rendered by an older Hosting
build: the visible bitmap must correspond to the current network response.

## Secure Installer Preparation

Complete this section **before running `-Install`**. The trusted administrator
prepares the installer configuration on Windows. The
normal workflow retrieves `SCANNER_QR_ADMIN_TOKEN` through the authenticated
Firebase CLI process and writes a token-only `multimedica-installer.json`.

### 1. Create the required installer configuration

From the `multimedica-scanner` repository directory, run:

```powershell
cd C:\path\to\multimedica-scanner
.\provision-scanner.ps1 `
  -CreateInstallerConfig `
  -FirebaseProjectId alfarero-478ad
```

The script prompts for the destination path. Press Enter for the default
`.\multimedica-installer.json` path shown by the prompt, or enter an approved
protected path. It does not display the token.

The Firebase CLI is started as a child process with stdout and stderr redirected
internally. The token is not a process argument, PowerShell output, log,
transcript, exception, or provisioning result. The child process must return one
non-empty single-line token. Extra output or an invalid value fails safely.

If `-FirebaseProjectId` is omitted, the explicit offline/recovery alternative
preserves the existing hidden prompt:

```powershell
cd C:\path\to\multimedica-scanner
.\provision-scanner.ps1 -CreateInstallerConfig
```

The trusted administrator must enter the exact existing token at the hidden
`Read-Host -AsSecureString` prompt. Do not print, copy into a second file, or
display the value.

If the destination already exists, the script requires an explicit `yes`
confirmation before replacement. Retrieval and validation occur before the
protected candidate replaces an existing file. A failed retrieval or permission
operation leaves the existing valid configuration in place.

### 2. Confirm that the required file exists

Run this command from the same directory, without displaying the file's
contents:

```powershell
if (Test-Path -LiteralPath .\multimedica-installer.json) { 'installer-config-present' } else { 'installer-config-missing' }
```

Do not continue to `-Install` unless the command prints
`installer-config-present`. If it prints `installer-config-missing`, repeat step
1 and confirm that you accepted the default destination or use the same approved
path for both `-CreateInstallerConfig` and `-InstallerConfig`.

The file must contain only `qr_admin_token` according to
`schemas/installer-config.schema.json`. Do not use any file-reading command to
display it.

### Installer parameter-set inventory

The six operational modes all write the machine-readable result to
`provisioning-result.json`, unless `-ResultFile` supplies another path:

| Mode               | Mandatory parameters         | Milestone 2 use                                        |
| ------------------ | ---------------------------- | ------------------------------------------------------ |
| `-Install`         | `-PiHost`                    | Bootstrap installation and optional reboot             |
| `-Verify`          | `-PiHost`                    | Read-only state and service verification               |
| `-Commission`      | `-PiHost`                    | Not used; current implementation is a Milestone 5 stub |
| `-Repair`          | `-PiHost`                    | Safe bootstrap reinstall                               |
| `-InstallRelease`  | `-PiHost`, `-ReleaseVersion` | Not used; Milestone 5 placeholder                      |
| `-RollbackRelease` | `-PiHost`, `-ReleaseVersion` | Not used; Milestone 5 placeholder                      |

The separate `-CreateInstallerConfig` utility writes only the selected
`multimedica-installer.json` path and does not write a provisioning result. The
`-ConfigureSshAccess` utility establishes and verifies the dedicated
workstation-to-Pi provisioning key and likewise does not write a provisioning
result.

## Bootstrap Installation Through PowerShell

This section assumes that **Secure Installer Preparation** has been completed
and that the presence check printed `installer-config-present`.

Before running `-Install`, confirm that this newly imaged Pi has completed the
required SSH-access step:

```powershell
.\provision-scanner.ps1 `
  -ConfigureSshAccess `
  -PiHost <pi-user>@<pi-host-or-ip>
```

Required result:

```text
Key-based SSH verified; provisioning will not prompt for the Pi password
```

Do not proceed to `-Install` without that result. A public key installed on a
different Pi does not satisfy this prerequisite.

Use the configured username and verified hostname or IP address in the single
`-PiHost` value. For initial provisioning, prefer the router-confirmed IP
address if local hostname resolution is unavailable or points to a different
address. Replace `<pi-user>@<pi-host-or-ip>` with the same target that passed the
interactive SSH test.

```powershell
.\provision-scanner.ps1 `
  -Install `
  -PiHost <pi-user>@<pi-host-or-ip> `
  -InstallerConfig .\multimedica-installer.json `
  -ResultFile .\provisioning-result.json
```

The PowerShell installer performs the transfer. It copies bootstrap and schema
files to remote `/tmp/mm-bootstrap-xfr`, creates a local temporary token file,
transfers it with `scp`, deletes the local temporary file in `finally`, and
invokes the bootstrap installer remotely. The remote transfer file is consumed
and deleted by `install-bootstrap.sh`; it is never manually created or copied.

Before transfer, the installer runs the capability-based platform preflight.
For the qualified baseline it must confirm Raspberry Pi hardware, `aarch64`,
Debian 13/Trixie, at least 8 GiB free storage, Node.js 20, Chromium, and the
required runtime packages. Image build, kernel, Chromium patch level, board
model, and board revision are evidence, not permanent equality locks. A future
Pi that satisfies the hard capabilities may continue with a warning that the
model is compatible but not yet physically qualified; record and review that
warning rather than editing the script to impersonate a Pi 4B.

On a clean Raspberry Pi OS image, the remote installer checks for Node.js, npm,
rsync, curl, sudo, the X kiosk runtime, Chromium, and cursor/display utilities.
Missing packages are installed from the configured Debian repositories. A
package-repository failure is reported as an installation failure; restore
Ethernet/repository access and rerun the same idempotent `-Install` command.

The first clean-image bootstrap can take several minutes or longer while
`apt-get` and `npm` download and install packages. The PowerShell script warns
the operator before this phase. Do not interrupt it while package output
continues. Later idempotent runs should normally be faster because installed
packages are reused.

Expected terminal result includes:

```text
==> Preparing remote staging
==> Checking qualified platform capabilities
==> Copying bootstrap source
==> Copying schemas
==> Transferring bootstrap token
==> Running bootstrap installer
RESULT: PASS
```

The exact phase list can include additional package and service messages. No
token value should appear.

Acceptance checkpoint: `provisioning-result.json` exists and validates against
`schemas/provisioning-result.schema.json`; `exit_code` is `0` and
`bootstrap_complete` is `true`.

Failure indication: `RESULT: FAIL`, a nonzero exit code, an SSH failure, or a
service-health failure. Preserve the non-secret terminal diagnostic and stop.

If port 3001 is occupied, the bootstrap installer aborts with a conflict
diagnostic. Do not stop, disable, replace, or reconfigure `kiosk-display.service`
or any legacy scanner service. Leave the process untouched and investigate the
unexpected clean-Pi condition.

## Initial Verification

Use the same Windows installer for read-only verification:

```powershell
.\provision-scanner.ps1 `
  -Verify `
  -PiHost <pi-user>@<pi-host> `
  -ResultFile .\provisioning-result.json
```

The installer queries the controller at `http://127.0.0.1:3000/api/status`
through SSH and checks display health at
`http://127.0.0.1:3001/api/health`.

Expected initial state:

```text
State: bootstrap_installed | Config complete: False
```

The display state label is `Scan Wi‑Fi QR to begin`. Missing configuration must
include the required categories rather than claiming completion.

Acceptance checkpoint: `multimedica-display.service`,
`multimedica-controller.service`, and `multimedica-kiosk.service` are active;
the controller status is reachable; the Chromium kiosk process is active; the
physical screen displays `Scan Wi‑Fi QR to begin`; and
`configuration_complete` is `false`. A console login prompt on the physical
screen is a failure even if both HTTP endpoints respond.

## Wi-Fi QR

In the authenticated Spanish admin page, select Wi-Fi, enter SSID, password, and
security, then choose the backend Wi-Fi QR generation action. The browser sends
the operator fields over HTTPS with a Firebase ID token. The backend validates
them and returns the existing `MMCFG:` version-1 QR with `auth.admin_token`.

Scan that QR with the USB scanner.

Expected display results from `controller.js`, `commissioning.js`, and
`bootstrap/public/app.js`:

- Applying message: `Applying Wi‑Fi: <ssid>`
- Success message: `Wi‑Fi accepted: <ssid>`
- State label: `Wi‑Fi configured`
- Remaining list includes Station and Cloud configuration QR categories

Expected stored fields:

- `config.json`: `wifi_ssid`, `wifi_security`
- `secrets.json`: `wifi_password`

The password is not displayed in status, identity, logs, or the display server.

Acceptance checkpoint: `configuration_complete` remains `false` until Station
and Cloud are also accepted.

Failure indication: `QR rejected: Invalid admin token`, a validation error, or a
Wi-Fi application error. Rescan the backend-generated QR or correct the form and
generate a new one. Do not edit Pi secret files manually.

## Station QR

In the admin page, select Station and enter the location, room, station, and
device identifiers. Choose backend Station QR generation, then scan the returned
`MMCFG:` version-1 QR.

Expected display results:

- Success message: `Station accepted: <station_id>`
- State label: `Station configured`
- Missing list still includes Cloud until Cloud is accepted

Expected stored non-secret fields in `config.json`:

- `location_id`
- `room_id`
- `station_id`
- `device_id`

Acceptance checkpoint: `configuration_complete` remains `false` unless Wi-Fi,
Station, and Cloud requirements are all present.

Failure indication: `QR rejected: Invalid admin token`, missing/invalid station
fields, or a safe configuration error. Correct the admin-page fields and
regenerate the QR.

## Cloud QR

In the admin page, select Cloud and request Cloud QR generation. The existing
backend generator supplies server-owned `endpoint_url`, `shared_secret`, and
`auth.admin_token` in the existing MMCFG version-1 envelope. Scan the returned
QR.

Expected display result:

- Success message: `Cloud configuration accepted`
- State label: `Configuration complete` only when Wi-Fi, Station, and Cloud are
  all complete
- Missing list is empty only when all three commissioning categories are present

Expected stored fields:

- `config.json`: `endpoint_url`
- `secrets.json`: `shared_secret`

The secret value is not displayed or included in the controller status response.

Acceptance checkpoint: `configuration_complete` is `true` only after Wi-Fi,
Station, and Cloud are all accepted. `commissioning_complete` remains `false`
and `production_ready` remains `false` in Milestone 2 because no production
release is installed.

Failure indication: `QR rejected: Invalid admin token`, missing cloud fields, or
an unavailable backend QR response. Confirm backend authentication and
`permissions.settings`, then generate a new Cloud QR.

## Show Identity QR

Select Scanner Identity in the admin page. This QR is generated locally and is a
non-configuration command:

```json
{
  "kind": "show_identity",
  "version": 1,
  "payload": {}
}
```

It has no `auth` object and does not require the QR administrator token in the QR.
The Pi parser accepts only an empty identity payload. Scan it after bootstrap has
started.

Expected display fields are exactly:

- Location
- Room
- Station
- Device ID

These are the non-secret identity fields sent by `controller.js`. The identity
command changes no configuration and exposes no secrets.

Acceptance checkpoint: identity display appears without changing
`configuration_complete`, `config.json`, or `secrets.json`.

Failure indication: a rejected QR or unavailable display. Confirm the controller
and display services are active, then rescan the local identity QR.

## Reboot and Recovery Verification

The normal `-Install` mode may reboot unless `-NoReboot` is supplied. After all
three configuration QRs have been accepted, perform one controlled power-cycle
as the final cold-start test. Remove power, wait at least five seconds, restore
power, wait for the kiosk screen, and then verify:

```powershell
.\provision-scanner.ps1 `
  -Verify `
  -PiHost <pi-user>@<pi-host> `
  -ResultFile .\provisioning-result.json
```

Expected result: the physical kiosk returns without a console login prompt;
controller, display, and kiosk services are active; the status endpoint
responds; the scanner reader is active; and previously accepted non-secret
configuration remains present with `configuration_complete: true`.

For a bootstrap repair, use the existing PowerShell repair mode:

```powershell
.\provision-scanner.ps1 `
  -Repair `
  -PiHost <pi-user>@<pi-host> `
  -InstallerConfig .\multimedica-installer.json `
  -ResultFile .\provisioning-result.json
```

Repair preserves valid state and uses the same protected token-transfer path.
Do not use `-InstallRelease`, `-RollbackRelease`, or `-Commission` for this
bootstrap acceptance procedure; release modes are Milestone 5 placeholders and
`-Commission` is not a completed commissioning operation.

## Final State Verification

Run the read-only installer verification again:

```powershell
.\provision-scanner.ps1 `
  -Verify `
  -PiHost <pi-user>@<pi-host> `
  -ResultFile .\provisioning-result.json
```

Record only the non-secret result fields:

- `bootstrap_complete`
- `configuration_complete`
- `commissioning_complete`
- `release_installed`
- `production_ready`
- `platform_verified`
- `services_healthy`
- `reboot_verified`
- `scanner_device_detected`
- `provisioning_qr_parsed`
- `errors`
- `warnings`

Do not display `multimedica-installer.json`, `secrets.json`, or any transfer
file.

## Cleanup

The implemented workflow automatically deletes:

- The local temporary token-transfer file created by PowerShell.
- The remote `/tmp/mm-bootstrap-xfr/secrets-transfer.json` after bootstrap
  installation, using `shred -u` when available and `rm -f` otherwise.

The remote staging directory is not removed by the implemented installer and
contains transferred software files, not the consumed token file. No cleanup
parameter set exists for it.

Keep `multimedica-installer.json` while repair or verification may be required.
After acceptance evidence is complete, an authorized administrator may remove
the local sensitive file without displaying it:

```powershell
Remove-Item -LiteralPath .\multimedica-installer.json -Force
```

Do not remove it before the final verification if repair may be needed.

## Troubleshooting

### Hostname does not resolve or resolves to the wrong address

Confirm the current address in the router's DHCP-client list. Use the verified
IP address in both the interactive SSH test and `-PiHost`. Correct stale local
DNS or DHCP hostname information separately; it does not need to block initial
provisioning by IP address.

### SSH host identification changed

This is expected after reflashing because the Pi receives new SSH host keys. Do
not bypass the warning blindly. Confirm the IP belongs to the newly reflashed Pi,
then run `ssh-keygen -R <pi-ip-address>` on the Windows workstation and reconnect
so the new key can be accepted.

### SSH password is rejected

Confirm that the SSH command uses the recorded Linux username before the `@`.
The hostname shown on the Pi display is not the username. If the known username
and password still produce `Permission denied (publickey,password)`, stop. The
installer cannot correct login credentials without an authenticated connection.

### Installer asks for the SSH password repeatedly

Stop and complete **Required Step: Configure SSH access on every newly imaged
Pi**. The
installer intentionally does not accept, cache, log, or inject the Pi password.
Operational modes in the corrected installer stop before transfer if dedicated
key authentication is unavailable.

### Firebase retrieval fails

Do not retry by printing command output or copying a value into another file.
Confirm Firebase CLI authentication and project access, then rerun:

```powershell
.\provision-scanner.ps1 `
  -CreateInstallerConfig `
  -FirebaseProjectId alfarero-478ad
```

### Installer configuration already exists

The script requires an explicit `yes` before replacement. Answer `no` to keep
the existing file. Failed retrieval and failed protection leave an existing
valid file in place.

### Port 3001 conflict

Stop the acceptance test and collect non-secret diagnostics. Do not stop or
disable `kiosk-display.service`, legacy scanner services, or any production
runtime. The clean-Pi prerequisite was not satisfied if one is active.

### Physical display remains at a console login prompt

The HTTP display server alone is insufficient. Run `-Verify` and require both
`multimedica-kiosk.service active` and `Physical kiosk browser process active`.
If either check fails, preserve the reported diagnostic and stop. Do not launch
Chromium manually; repair the supported kiosk service path.

### Scanner not detected

The scanner reader searches `/proc/bus/input/devices` for the exact configured
device name `BF SCAN SCAN KEYBOARD`, resolves an `eventN` handler to
`/dev/input/eventN`, and starts `evtest` directly on that event device. The
installer adds `multimedica_edge` to the least-privilege `input` group and the
controller unit declares `SupplementaryGroups=input`; it does not run `evtest`
through `sudo`.

`-Verify` requires both `Scanner USB device detected` and `Scanner evtest reader
active`. If the reader is unavailable, the physical display reports `Scanner
unavailable. Check the USB connection.` A service/HTTP-only result must not be
accepted as PASS.

Do not use a serial-device path; that is not the implemented detection
mechanism. Check the USB connection and device name, then rerun the PowerShell
verification.

### QR rejected

The protected Cloud, Station, and Wi-Fi QRs require the Pi’s stored
`qr_admin_token`. Generate them through the authenticated backend and rescan.
Show Identity is local, has no auth object, and must have an empty payload.

If a protected QR reports `Invalid admin token`, do not edit Pi state or compare
secret values in logs. Recreate `multimedica-installer.json` through the
approved Firebase workflow, rerun the idempotent `-Install` or `-Repair`, deploy
the current function and Hosting builds if needed, hard-refresh the admin page,
and generate a new QR. A phone decode of the displayed QR and the current
backend response must describe the same newly generated envelope; never record
the token itself.

### Platform preflight fails

Do not bypass the check. Preserve the non-secret failure text and confirm the
qualified Trixie image, architecture, free storage, and package-repository
access. The remote probe is transported as encoded script content so Windows
OpenSSH cannot reinterpret embedded shell quotes; a result such as
`Unsupported hardware: 1.5` indicates an outdated provisioning script, not a
real board model. Update the repository files together and rerun the same
command.

## Acceptance Checklist

- [ ] Newly imaged compatible Raspberry Pi and exact model/revision recorded
- [ ] Qualified 2026-06-18 Trixie Lite image SHA-256 verified and recorded
- [ ] Downloaded ZIP/scripts unblocked when applicable without weakening execution policy
- [ ] Username and hostname recorded without assuming `pi`
- [ ] Current Pi IP address confirmed in the router's DHCP-client list
- [ ] Successful interactive SSH login completed with `<pi-user>@<pi-ip-address>`
- [ ] `-ConfigureSshAccess` completed for this newly imaged Pi
- [ ] Key-based SSH check completed without a password prompt
- [ ] Ethernet, display, power, and USB scanner connected
- [ ] Wi-Fi left unconfigured during imaging
- [ ] Initial Ethernet connection has Debian package-repository access
- [ ] Firebase project access confirmed without recording secret values
- [ ] `multimedica-installer.json` created through the approved command
- [ ] Installer configuration presence check printed `installer-config-present`
- [ ] No manual `secrets-transfer.json` was created
- [ ] No manual `scp` or direct `install-bootstrap.sh` invocation was used
- [ ] PowerShell `-Install` completed with exit code 0
- [ ] Capability-based platform preflight passed; any compatibility warning recorded
- [ ] Controller, display-server, and physical-kiosk services active
- [ ] Physical kiosk browser process active
- [ ] Physical screen displays the bootstrap QR instruction rather than a login prompt
- [ ] Scanner USB device detected and evtest reader active
- [ ] Wi-Fi QR accepted
- [ ] Station QR accepted
- [ ] Cloud QR accepted
- [ ] `configuration_complete` true only after all three categories
- [ ] `commissioning_complete` false in Milestone 2
- [ ] Show Identity displayed only non-secret identity fields
- [ ] Controlled power-cycle and post-boot `-Verify` completed
- [ ] Temporary transfer files were deleted by the implemented workflow
- [ ] Physical QR readability and scanner response accepted on the target hardware

## Evidence-Recording Table

| Item        | Evidence to record                                                              | Secret-safe? |
| ----------- | ------------------------------------------------------------------------------- | ------------ |
| OS image    | Exact filename, date, URL, verified SHA-256, and pi-gen build                   | Yes          |
| Platform    | Pi model/revision, architecture, kernel, Node, Chromium, display mode, warnings | Yes          |
| Pi identity | Hostname, non-secret username, and current IP address                           | Yes          |
| Install     | `provisioning-result.json` fields and exit code                                 | Yes          |
| Services    | `systemctl is-active` results as reported by installer                          | Yes          |
| Controller  | `GET /api/status` reached through `-Verify`                                     | Yes          |
| Display     | `GET /api/health` reached through installer health check                        | Yes          |
| Scanner     | `scanner_device_detected` and device-name evidence                              | Yes          |
| QR sequence | Kind, order, result, display state                                              | Yes          |
| Identity    | Location, Room, Station, Device ID only                                         | Yes          |
| Cleanup     | Transfer-file absence check and local config disposition                        | Yes          |

## Qualified Baseline and Remaining Work

The established baseline is Raspberry Pi OS Lite 64-bit 2026-06-18, Debian
13.5/Trixie, on a Raspberry Pi 4 Model B Rev 1.5 (`aarch64`), with Node.js
20.19.2 at `/usr/bin/node`, npm 9.2.0, Chromium 151.0.7922.108, HDMI-1 at
480x800 portrait, and the BF SCAN `9901:0301` keyboard-wedge scanner. These
observations are acceptance evidence; patch versions and the Pi 4 model string
are not permanent hard-coded requirements.

Remaining work is limited to the acceptance result for each deployed unit,
enclosure-specific display mounting/cable routing/power documentation, physical
qualification of any future Pi model, and later production-release milestones.
Production release installation and `multimedica-production.service` remain
outside this procedure.
s