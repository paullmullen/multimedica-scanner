# Multimedica Scanner Appliance Installation Guide

**Audience:** Technical installer
**Applies to:** New or freshly reimaged Raspberry Pi scanner appliances
**Qualified baseline:** Raspberry Pi 4 Model B, Raspberry Pi OS Lite 64-bit, Debian 13 Trixie
**Last validated:** August 2026

---

## 1. Purpose

This guide describes the supported procedure for turning a clean Raspberry Pi into a commissioned Multimedica scanner with a validated production release.

Use the Windows provisioning script for installation and verification. Do not clone the repository onto the Pi, copy individual runtime files manually, or edit files under `/opt/multimedica-scanner` as part of ordinary installation.

For architectural reasoning, see [Installation and Commissioning Theory of Operation](SCANNER-INSTALLATION-THEORY-OF-OPERATION.md).

---

## 2. What the procedure installs

The completed appliance contains two software layers:

1. **Bootstrap layer:** scanner input, QR commissioning, display, kiosk, release management, and recovery.
2. **Production release:** versioned everyday scan processing and clinic-cloud communication.

These layers are installed and accepted separately. A completed bootstrap installation does not by itself mean production is installed.

---

## 3. Command conventions

| Label | Meaning |
|---|---|
| **Windows** | Run in Windows PowerShell from the repository root |
| **Scanner** | Scan a printed QR with the appliance barcode scanner |
| **Physical** | Observe or manipulate the Pi, display, cables, or power |

PowerShell continuation commands use the backtick character at the end of each continued line. Do not add characters after the backtick.

The repository root is the directory containing:

```text
provision-scanner.ps1
package.json
bootstrap/
production/
tests/
```

---

## 4. Stop conditions

Stop the procedure and investigate if any of the following occurs:

- the provisioning script reports `RESULT: FAIL`;
- SSH reports an unexpected host-key change and the Pi was not deliberately reimaged;
- a password is displayed in clear text or appears in captured output;
- a required QR is rejected;
- the scanner USB device or reader is not detected;
- the physical display does not show `CANDIDATO` during release installation;
- production health does not pass;
- the final clinic display or real-patient scan is incorrect.

Do not continue merely because a later step might appear to work. Preserve `provisioning-result.json` and the console output for diagnosis.

---

## 5. Required hardware

- Raspberry Pi 4 Model B
- 32 GB or larger high-quality microSD card
- Qualified HDMI portrait display
- HDMI jumper or cable required by the display
- Display standoffs and mounting hardware
- BF SCAN USB barcode scanner
- Raspberry Pi USB-C power supply
- Right-angle USB-C cable when required by the enclosure
- Ethernet cable or Wi-Fi network access
- Completed scanner enclosure and suitable fasteners

Qualified reference hardware and image details are recorded in [Bootstrap Architecture](bootstrap-architecture.md).

---

## 6. Hardware assembly

Perform assembly with power disconnected.

### 6.1 Mount the display

1. Align the display with the Raspberry Pi GPIO header if the display uses that header mechanically or electrically.
2. Confirm every pin is aligned before applying pressure.
3. Install the HDMI jumper between the display and the Pi micro-HDMI port.
4. Confirm the jumper is fully seated and not under tension.
5. Install the required standoffs and screws.

The completed assembly must be rigid, with no bent GPIO pins or stressed HDMI connectors.

### 6.2 Connect the scanner

Connect the BF SCAN scanner to a Raspberry Pi USB port. Do not assume the Linux event-device number; the bootstrap reader discovers the device dynamically.

### 6.3 Route cables

The appliance operates in portrait orientation. Route scanner, network, and other external cables through the intended enclosure exit. Use a right-angle USB-C power cable when necessary to avoid enclosure interference.

### 6.4 Hardware check

- [ ] Display firmly mounted
- [ ] HDMI connection fully seated
- [ ] Scanner connected by USB
- [ ] microSD card installed
- [ ] Network connection available
- [ ] Power cable fits without stress
- [ ] No exposed conductor, pin, or board is shorted by the enclosure

---

## 7. Prepare configuration and release materials

Complete this section on the Windows provisioning workstation before installing the Pi.

### 7.1 Obtain the approved repository revision

Use an approved, tested repository revision. Do not perform development changes during a field installation.

From the repository root, confirm the working tree is clean:

```powershell
git status --short
```

For an approved installation package rather than a Git checkout, extract it into a local working directory while preserving its folder structure.

### 7.2 Unblock the provisioning script when required

Files downloaded through a browser or received in a ZIP may carry a Windows security mark.

```powershell
Unblock-File .\provision-scanner.ps1
```

### 7.3 Prepare the installer configuration

The protected installer configuration contains the QR administrator token used to authorize commissioning QRs.

If an approved `multimedica-installer.json` already exists:

```powershell
Test-Path .\multimedica-installer.json
```

Expected:

```text
True
```

If it must be created:

```powershell
.\provision-scanner.ps1 -CreateInstallerConfig
```

Follow the hidden token prompt. Keep this file secure and never commit it to Git.

### 7.4 Prepare the configuration QRs

Generate the authorized QRs from the Multimedica administrative interface:

- Wi-Fi configuration QR
- Station configuration QR
- Cloud configuration QR
- Identity QR for future diagnostics

Printed Wi-Fi and Cloud QRs contain credentials. Control and destroy unneeded copies appropriately.

The Identity QR is not currently a required acceptance step because a physical no-response defect remains under investigation.

### 7.5 Obtain the production artifact

The installer needs an approved production `.tgz` artifact, its version, and its SHA-256 value.

If the release owner is building a new production release, use a new semantic version. Never rebuild different content under a previously published version.

Example:

```powershell
npm run build:production-release -- 1.0.5 .\release-output
```

Select the artifact and calculate its local hash:

```powershell
$artifact = (Resolve-Path .\release-output\multimedica-production-1.0.5.tgz).Path
$sha = (Get-FileHash $artifact -Algorithm SHA256).Hash.ToLowerInvariant()

$artifact
$sha
Get-Content .\release-output\multimedica-production-1.0.5.tgz.sha256
```

The calculated hash must match the sidecar file before installation.

Ordinary field installers should receive an already approved artifact and hash rather than choosing or building a version themselves.

---

## 8. Image the Raspberry Pi

### 8.1 Approved image

Use the qualified Raspberry Pi OS Lite 64-bit image listed in `bootstrap-architecture.md`. Verify the downloaded compressed-image SHA-256 before imaging.

Do not substitute Raspberry Pi OS Desktop, a 32-bit image, or an unqualified major OS release.

### 8.2 Raspberry Pi Imager settings

In Raspberry Pi Imager:

1. Select Raspberry Pi 4.
2. Select the approved Raspberry Pi OS Lite 64-bit image.
3. Configure a unique hostname.
4. Set username:

   ```text
   multimedica_edge
   ```

5. Set and securely record the Pi account password.
6. Enable SSH with password authentication for initial provisioning.
7. Set the intended locale, keyboard, and timezone.
8. Optionally configure Wi-Fi. The commissioning QR remains supported even when image-time Wi-Fi is supplied.

Recommended hostname examples:

```text
multimedicascanner1
multimedica-lab-01
multimedica-reg-01
```

Record:

```text
Hostname:
Pi IP address:
Location:
Station:
Room ID:
Device ID:
Production version:
Installer/date:
```

### 8.3 First boot

1. Insert the microSD card.
2. Connect display, scanner, and network.
3. Apply power.
4. Allow the first boot to finish.

From Windows, confirm the Pi is reachable:

```powershell
ping multimedicascanner1
```

If name resolution is unavailable, use the Pi IP address in `-PiHost`.

---

## 9. Establish provisioning SSH access

**Windows:**

```powershell
.\provision-scanner.ps1 `
  -ConfigureSshAccess `
  -PiHost multimedica_edge@multimedicascanner1
```

When asked whether the Pi was reimaged:

- answer lowercase `yes` for a newly imaged card;
- answer lowercase `no` only when the existing SSH identity is expected.

Enter the Pi account password when SSH requests it. The script installs and verifies a dedicated provisioning public key. Successful output ends with:

```text
Key-based SSH verified; provisioning will not prompt for the Pi password
```

If SSH reports an identity change after answering `no`, stop and verify that this is the intended physical Pi.

---

## 10. Install the bootstrap platform

**Windows:**

```powershell
.\provision-scanner.ps1 `
  -Install `
  -PiHost multimedica_edge@multimedicascanner1 `
  -InstallerConfig .\multimedica-installer.json `
  -ResultFile .\provisioning-result.json
```

At the sudo prompt, enter the Pi password once and press Enter. The password will not appear. Wait after pressing Enter; do not type it again unless another visible prompt appears.

The first installation may take several minutes while operating-system and npm packages are installed.

The script will:

- check the platform baseline;
- stage bootstrap files;
- install dependencies and services;
- install restricted privileged helpers;
- start and validate controller, display, and kiosk services;
- verify the scanner device and reader;
- reboot the Pi;
- verify that services recover after reboot.

During installation, the physical screen may show:

```text
Finalizando la instalación
Espere. No escanee códigos todavía.
```

Do not scan configuration QRs until the installation marker clears and the display requests configuration.

Required console result:

```text
RESULT: PASS
```

---

## 11. Commission the scanner

Scan QRs only after bootstrap installation has passed and the display requests configuration.

### 11.1 Wi-Fi QR

**Scanner:** Scan the Wi-Fi QR when Wi-Fi configuration is required.

The Pi applies and verifies the NetworkManager connection before storing it as authoritative. If the QR fails, do not continue on the assumption that image-time Wi-Fi is sufficient; preserve the message and diagnose the failure.

Applying different Wi-Fi credentials may temporarily interrupt SSH or change the Pi address.

### 11.2 Station QR

**Scanner:** Scan the Station QR.

Verify that the display acknowledges the station configuration in Spanish.

### 11.3 Cloud QR

**Scanner:** Scan the Cloud QR.

Verify that the display acknowledges the cloud configuration in Spanish.

When all required configuration is accepted, the display should show:

```text
Configuración completa
```

The controller may retain previously valid Station or Cloud configuration on a reinstallation. If it does not request a QR, use `-Verify` to inspect the actual configuration state rather than assuming a scan was ignored.

---

## 12. Verify bootstrap and commissioning

**Windows:**

```powershell
.\provision-scanner.ps1 `
  -Verify `
  -PiHost multimedica_edge@multimedicascanner1 `
  -ResultFile .\provisioning-result.json
```

Required observations include:

- configuration complete;
- display service active;
- controller service active;
- kiosk service active;
- display health endpoint responsive;
- physical Chromium kiosk active;
- scanner USB device detected;
- scanner reader active.

Required result:

```text
RESULT: PASS
```

Do not install production if verification fails.

---

## 13. Install the production release

Set the artifact path and verify the hash if not already done:

```powershell
$artifact = (Resolve-Path .\release-output\multimedica-production-1.0.5.tgz).Path
$sha = (Get-FileHash $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
```

Use the artifact’s actual version in all three places below:

```powershell
.\provision-scanner.ps1 `
  -InstallRelease `
  -PiHost multimedica_edge@multimedicascanner1 `
  -ReleaseVersion 1.0.5 `
  -ArtifactPath $artifact `
  -ArtifactSha256 $sha `
  -ResultFile .\provisioning-result.json
```

The installer stages and validates the release, starts it as an isolated candidate, and asks:

```text
Confirm the physical display showed the CANDIDATO state.
Type lowercase yes to continue:
```

Inspect the physical Pi display.

- If it visibly shows `CANDIDATO`, type lowercase `yes` and press Enter.
- If it does not, do not authorize promotion.

A successful installation includes:

```text
INSTALL_RELEASE_COMPLETE
RESULT: PASS
```

The release is not recorded as known-good until production starts through the production service and passes health verification.

---

## 14. Final appliance acceptance

### 14.1 Read-only verification

Run `-Verify` again after production installation:

```powershell
.\provision-scanner.ps1 `
  -Verify `
  -PiHost multimedica_edge@multimedicascanner1 `
  -ResultFile .\provisioning-result.json
```

Confirm `RESULT: PASS` and that production is active and healthy.

### 14.2 Physical clinic state

Confirm that the display:

- uses portrait orientation;
- fills the intended display area;
- uses the approved El Alfarero logo, colors, and layout;
- reports the correct station and clinic state;
- contains no unexpected English commissioning text.

### 14.3 Real patient scan

Scan one approved real or designated acceptance patient barcode.

Confirm:

- the scan is accepted by production;
- the expected cloud workflow occurs;
- the display updates to the expected clinic state;
- no obsolete “Patient Scan Accepted” overlay appears.

### 14.4 Cold-boot recovery

Perform one controlled power cycle or approved reboot. Allow the Pi to return without operator intervention.

Confirm:

- startup display remains stable rather than scrambled;
- bootstrap services return;
- release recovery authorizes the known-good production release;
- production becomes active;
- the correct clinic state returns.

Run `-Verify` one final time and retain the result with the installation record.

---

## 15. Supported maintenance operations

### 15.1 Diagnose without changing the Pi

Use:

```powershell
.\provision-scanner.ps1 -Verify ...
```

This should be the first action for an uncertain appliance state.

### 15.2 Update approved display resources

Use:

```powershell
.\provision-scanner.ps1 `
  -UpdateDisplay `
  -PiHost multimedica_edge@multimedicascanner1 `
  -ResultFile .\provisioning-result.json
```

Enter the Pi sudo password when requested. Do not manually copy display files onto the Pi.

### 15.3 Install new production code

Assign a new production version, build or obtain its approved artifact and hash, and use `-InstallRelease`.

Do not overwrite an installed version directory and do not reuse a version for different artifact contents.

### 15.4 Bootstrap repair

`-Repair` is intended for bootstrap states where release management permits broad repair. It intentionally refuses to overwrite a production-managed appliance when doing so could invalidate release and recovery state.

Do not bypass this refusal with manual root file copies. Escalate for a release-aware bootstrap upgrade or supported narrow update.

---

## 16. Installation record

Record at minimum:

```text
Installation date:
Installer:
Hostname:
Pi IP address:
Location:
Station:
Room ID:
Device ID:
Qualified image:
Repository revision:
Production version:
Production SHA-256:
Initial Verify result:
Post-release Verify result:
Cold-boot Verify result:
Physical display accepted:
Real scan accepted:
Notes:
```

Do not record passwords, QR administrator tokens, shared secrets, or Wi-Fi credentials in the installation record.

---

## 17. Completion checklist

- [ ] Qualified hardware assembled correctly
- [ ] Approved Pi image checksum verified
- [ ] Pi imaged with correct user and SSH settings
- [ ] `-ConfigureSshAccess` completed
- [ ] `-Install` returned `RESULT: PASS`
- [ ] Installation waiting marker cleared before QR scanning
- [ ] Required QRs accepted
- [ ] Display reported `Configuración completa`
- [ ] Pre-release `-Verify` returned `RESULT: PASS`
- [ ] Production artifact hash matched
- [ ] Physical display showed `CANDIDATO`
- [ ] `-InstallRelease` returned `RESULT: PASS`
- [ ] Post-release `-Verify` returned `RESULT: PASS`
- [ ] Correct clinic state displayed
- [ ] Real patient scan accepted
- [ ] Cold boot recovered production and stable display
- [ ] Final `-Verify` returned `RESULT: PASS`
- [ ] Installation record completed without secrets
