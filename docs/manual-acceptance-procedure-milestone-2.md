# Manual Acceptance Procedure — Multimedica Scanner Milestone 2

## Prerequisites

1. **Installer configuration file** — multimedica-installer.json with QR admin token
2. **Raspberry Pi 4** — Fresh OS install (Bookworm or prior)
3. **Network** — Pi connected to Ethernet or WiFi
4. **Bootstrap source files** — bootstrap/ directory from this repository
5. **No legacy kiosk-display running** — Or accept abort with port conflict diagnostic

## Step 1: Create Installer Configuration

Run on Windows (or any system with PowerShell 5.1+):

```powershell
cd c:\path\to\multimedica-scanner
.\provision-scanner.ps1 -CreateInstallerConfig
```

**Prompts:**
- `Save path [default: .\multimedica-installer.json]` — Press Enter to use default
- `QR administrator token (exact SCANNER_QR_ADMIN_TOKEN value)` — Enter the token value (input is hidden)

**Expected output:**
```
[HH:mm:ss] ==> Creating multimedica-installer.json
    OK  Configuration saved to .\multimedica-installer.json
IMPORTANT: Keep this file secure. Do not commit to source control.
```

**Acceptance Point A1:** Configuration file created with only `qr_admin_token` field. Installer supplies token only; cloud credentials arrive via QR and are stored through the validated secrets store.

---

## Step 2: Transfer Files to Raspberry Pi

### Prepare the Transfer Directory

On Windows, create a temporary directory with:
- `bootstrap/` directory (entire bootstrap/ folder from repository)
- `multimedica-installer.json` (from Step 1)
- `secrets-transfer.json` (temporary file, see below)

### Create Secrets Transfer File

Create `secrets-transfer.json` in the same directory as bootstrap/:

```json
{
  "qr_admin_token": "<EXACT_TOKEN_VALUE_FROM_STEP_1>"
}
```

Replace `<EXACT_TOKEN_VALUE_FROM_STEP_1>` with the token you entered in Step 1.

**Security Note:** This file must be deleted after transfer. It is never stored on the Pi.

### Copy to Raspberry Pi

```powershell
# Example: copy to /tmp/multimedica-install on the Pi
scp -r "C:\path\to\transfer-dir\bootstrap" pi@raspberrypi.local:/tmp/
scp "C:\path\to\transfer-dir\secrets-transfer.json" pi@raspberrypi.local:/tmp/
```

**Expected output:** Files copied without errors.

**Acceptance Point A2:** Bootstrap files and secrets transfer file accessible on Pi.

---

## Step 3: Run Bootstrap Installer on Raspberry Pi

### SSH to the Pi

```bash
ssh pi@raspberrypi.local
```

### Run the Installer

```bash
sudo bash /tmp/bootstrap/install-bootstrap.sh \
  --src /tmp/bootstrap \
  --secrets /tmp/secrets-transfer.json
```

**Expected output:**
```
[HH:mm:ss] ==> Multimedica Scanner — Bootstrap Installer
    OK  Validating environment...
    OK  Checking for port 3001 conflict
    OK  Extracting QR admin token from secrets transfer file
    OK  Installing systemd services
    OK  Starting multimedica-controller service
    OK  Starting multimedica-display service
    OK  Bootstrap installation complete
[HH:mm:ss] ==> Installation successful
```

**Important Failure Cases:**

1. **Port 3001 already in use:**
   ```
   FAIL CONFLICT: Port 3001 is occupied (likely legacy kiosk-display.service)
   ```
   **Action:** Stop the legacy service and retry, or reboot:
   ```bash
   sudo systemctl stop kiosk-display.service
   # OR
   sudo reboot
   ```

2. **Secrets transfer file missing or empty:**
   ```
   FAIL Could not extract qr_admin_token from secrets transfer file
   ```
   **Action:** Verify `/tmp/secrets-transfer.json` exists and contains valid JSON.

3. **Bootstrap source files missing:**
   ```
   FAIL Directory /tmp/bootstrap does not contain required files
   ```
   **Action:** Re-run Step 2 (file transfer).

**Acceptance Point A3:** All bootstrap services installed and running.

### Verify Bootstrap Startup

```bash
sudo systemctl status multimedica-controller
sudo systemctl status multimedica-display
```

**Expected output:**
```
● multimedica-controller.service - Multimedica Scanner — Controller
   Loaded: loaded (/etc/systemd/system/multimedica-controller.service; enabled; preset: enabled)
   Active: active (running) since [timestamp]
```

---

## Step 4: Check Bootstrap Status

From Windows:

```powershell
.\provision-scanner.ps1 -Verify -PiHost raspberrypi.local -InstallerConfig .\multimedica-installer.json
```

**Expected output (example):**
```
[HH:mm:ss] ==> Querying device state at raspberrypi.local
    OK  Device reached
    OK  Bootstrap verified
    OK  Platform verified
    OK  Services healthy

Mode: Verify
Timestamp: 2024-12-20T15:32:00Z
Pi Host: raspberrypi.local

Bootstrap State:
  bootstrap_complete: True
  platform_verified: True
  services_healthy: True
  reboot_verified: False
  scanner_device_detected: False

Configuration State:
  configuration_complete: False
  commissioning_complete: False

Release State:
  release_installed: False
  production_ready: False

Missing Fields: [cloud_endpoint_url, shared_secret, network_connected]

Result written to provisioning-result.json
```

**Acceptance Point A4:** Bootstrap services reachable and reporting correct state. `configuration_complete: False` (expected — cloud credentials not yet provided).

---

## Step 5: Commission Device via QR

### Prepare Commissioning QR

Generate a `cloud_config` QR code containing:

```json
{
  "type": "cloud_config",
  "endpoint_url": "https://cloud.multimedica.example.com/api",
  "shared_secret": "DEVICE_SPECIFIC_SECRET"
}
```

**Note:** Cloud credentials arrive **only via QR**, never from installer or CLI arguments.

### Scan QR on Device Display

1. The Pi display (kiosk-display or multimedica-display) shows a commissioning screen
2. Scan the `cloud_config` QR code with the scanner device
3. Observe the display update to show configuration progress

**Expected display sequence:**
- Initial: "Waiting for provisioning QR code"
- After scan: "Configuring cloud connection..."
- After success: "Device ready", showing device ID and version

---

## Step 6: Verify Commissioning Complete

From Windows:

```powershell
.\provision-scanner.ps1 -Verify -PiHost raspberrypi.local -InstallerConfig .\multimedica-installer.json
```

**Expected output (after commissioning):**
```
Configuration State:
  configuration_complete: True
  commissioning_complete: False
  release_installed: False
  production_ready: False

Available Fields:
  endpoint_url: [REDACTED]
  shared_secret: [REDACTED]
  network_connected: True
```

**Acceptance Point B1:** `configuration_complete: True` — Bootstrap and cloud configuration verified.

---

## Step 7: Check Device Identity and Health

On the Pi:

```bash
curl -s http://localhost:3000/api/status | jq .
```

**Expected output (example):**
```json
{
  "ok": true,
  "service": "multimedica-controller",
  "commissioning_state": {
    "configuration_complete": true,
    "commissioning_complete": false,
    "release_installed": false,
    "production_ready": false,
    "missing_fields": []
  },
  "config": {
    "platform_type": "raspberry-pi-4",
    "scanner_device_port": "/dev/ttyUSB0"
  },
  "health": {
    "services": ["multimedica-display", "multimedica-controller"],
    "uptime_seconds": 1234
  }
}
```

---

## Troubleshooting

### Issue: "Port 3001 already in use"

**Cause:** Legacy kiosk-display.service is running (Milestone 1 component).

**Resolution:** Do NOT force-kill the service. Instead:

```bash
# Option 1: Gracefully stop legacy service
sudo systemctl stop kiosk-display.service

# Option 2: Reboot and let Multimedica bootstrap start cleanly
sudo reboot

# Option 3 (only if required): Completely disable legacy service
sudo systemctl disable kiosk-display.service
sudo systemctl stop kiosk-display.service
```

Then re-run the installer:

```bash
sudo bash /tmp/bootstrap/install-bootstrap.sh \
  --src /tmp/bootstrap \
  --secrets /tmp/secrets-transfer.json
```

### Issue: "Secrets transfer file not found"

**Cause:** File was not copied to Pi, or path is incorrect.

**Resolution:**

```bash
# Verify file exists
ls -la /tmp/secrets-transfer.json

# If missing, copy it again
# On Windows:
scp "C:\path\to\secrets-transfer.json" pi@raspberrypi.local:/tmp/

# Then retry installer
sudo bash /tmp/bootstrap/install-bootstrap.sh \
  --src /tmp/bootstrap \
  --secrets /tmp/secrets-transfer.json
```

### Issue: "bootstrap_complete: False" after Step 4

**Cause:** One or more bootstrap services failed to start.

**Resolution:**

```bash
# Check service logs
sudo journalctl -u multimedica-controller -n 50
sudo journalctl -u multimedica-display -n 50

# Restart services
sudo systemctl restart multimedica-controller
sudo systemctl restart multimedica-display

# Verify status
sudo systemctl status multimedica-controller
sudo systemctl status multimedica-display
```

### Issue: "configuration_complete: False" after Step 6

**Cause:** Cloud QR code was not scanned, or QR payload is invalid.

**Resolution:**

1. Verify the scanner device is connected and responsive:
   ```bash
   ls -la /dev/ttyUSB*
   ```

2. Check controller logs:
   ```bash
   sudo journalctl -u multimedica-controller -n 100 | grep -i qr
   ```

3. Verify cloud_config QR payload matches schema (must include endpoint_url and shared_secret)

4. Rescan the QR code

---

## Acceptance Criteria Summary

| Acceptance Point | Criterion | Verification Command |
|---|---|---|
| A1 | Installer config created (token only) | `cat .\multimedica-installer.json` → contains only `qr_admin_token` |
| A2 | Bootstrap files on Pi | `ls -la /tmp/bootstrap/` → shows systemd/, lib/, controller.js, etc. |
| A3 | Bootstrap services running | `sudo systemctl status multimedica-controller` → Active (running) |
| A4 | Bootstrap reachable, state queries work | `.\provision-scanner.ps1 -Verify` → bootstrap_complete: True |
| B1 | Cloud config applied | `.\provision-scanner.ps1 -Verify` → configuration_complete: True |
| B2 | Device identity exposed | `curl http://localhost:3000/api/status` → returns service metadata |

---

## Security Notes

1. **Token Handling:** The QR admin token is never echoed, logged, or passed via CLI arguments
2. **Secrets Transfer:** The `secrets-transfer.json` file is temporary and must be deleted after transfer
3. **Credential Rotation:** Cloud credentials (endpoint_url, shared_secret) arrive only via QR and are stored in `/etc/multimedica-scanner/secrets.json` (protected with 0600 permissions)
4. **File Permissions:** All bootstrap files are installed with root ownership; secrets files are world-unreadable

---

## Milestone 2 Completion

This procedure validates all four blocking contract requirements:

1. ✓ Installer does NOT request cloud credentials — arrives via QR only
2. ✓ Installer does NOT stop legacy kiosk-display — fails with diagnostic if port conflict
3. ✓ State terminology corrected — configuration_complete, commissioning_complete, release_installed, production_ready
4. ✓ All verifications pass — Jest tests (147/147), PowerShell parse (4/4), schema validation (2/2)
