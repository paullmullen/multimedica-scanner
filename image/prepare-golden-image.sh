#!/usr/bin/env bash

# Prepare a fully installed reference scanner for capture as a reusable image.
# Retains the QR authorization token and approved production release. Erases
# clinic Wi-Fi, station, and cloud configuration.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="/var/lib/multimedica-scanner/state"
IMAGE_DIR="/var/lib/multimedica-scanner/image"
SECRETS_FILE="$STATE_DIR/secrets.json"
CONFIG_FILE="$STATE_DIR/config.json"
BOOTSTRAP_DIR="/opt/multimedica-scanner/bootstrap"
CURRENT_LINK="/opt/multimedica-scanner/current"

log() { echo "[image-prep] $*"; }
fail() { echo "[image-prep] ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run with sudo"
[[ -d "$BOOTSTRAP_DIR" ]] || fail "Bootstrap installation not found"
[[ -L "$CURRENT_LINK" ]] || fail "No activated production release found"
[[ -f "$SECRETS_FILE" ]] || fail "Bootstrap secrets file not found"
[[ -x /usr/bin/node ]] || fail "Node.js not found at /usr/bin/node"

token_present="$(/usr/bin/node - "$SECRETS_FILE" <<'NODE'
const fs = require('fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).qr_admin_token;
process.stdout.write(typeof value === 'string' && value.length > 0 ? 'yes' : 'no');
NODE
)"
[[ "$token_present" == "yes" ]] || fail "QR authorization token is missing"

log "Stopping scanner services"
for unit in \
  multimedica-production.service \
  multimedica-kiosk.service \
  multimedica-controller.service \
  multimedica-display.service; do
  systemctl stop "$unit" 2>/dev/null || true
done

log "Removing clinic configuration while retaining QR authorization"
/usr/bin/node - "$SECRETS_FILE" "$CONFIG_FILE" <<'NODE'
const fs = require('fs');
const [secretsPath, configPath] = process.argv.slice(2);
const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
if (typeof secrets.qr_admin_token !== 'string' || !secrets.qr_admin_token) {
  throw new Error('qr_admin_token is missing');
}
const now = new Date().toISOString();
const cleanSecrets = {
  schema_version: 1,
  qr_admin_token: secrets.qr_admin_token,
  updated_at: now,
};
const cleanConfig = {
  schema_version: 1,
  commissioning_state: 'bootstrap_installed',
  bootstrap_version: '1.0.0',
  qr_schema_version: 1,
  config_schema_version: 1,
  updated_at: now,
};
fs.writeFileSync(`${secretsPath}.tmp`, `${JSON.stringify(cleanSecrets, null, 2)}\n`, { mode: 0o640 });
fs.renameSync(`${secretsPath}.tmp`, secretsPath);
fs.writeFileSync(`${configPath}.tmp`, `${JSON.stringify(cleanConfig, null, 2)}\n`, { mode: 0o640 });
fs.renameSync(`${configPath}.tmp`, configPath);
NODE
chown root:multimedica_edge "$SECRETS_FILE"
chown multimedica_edge:multimedica_edge "$CONFIG_FILE"
chmod 0640 "$SECRETS_FILE" "$CONFIG_FILE"

log "Removing configuration backups and transient release files"
find "$STATE_DIR/backups" -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true
find /var/lib/multimedica-scanner/release-transfer -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true
find /var/lib/multimedica-scanner/release-operation -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true

log "Removing saved network profiles from the reference device"
find /etc/NetworkManager/system-connections -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null || true

log "Installing automatic first-boot initialization"
install -o root -g root -m 0755 \
  "$REPO_ROOT/image/multimedica-image-firstboot" \
  /usr/local/sbin/multimedica-image-firstboot
install -o root -g root -m 0644 \
  "$REPO_ROOT/image/multimedica-image-firstboot.service" \
  /etc/systemd/system/multimedica-image-firstboot.service
systemctl daemon-reload
systemctl enable multimedica-image-firstboot.service
install -d -o root -g root -m 0755 "$IMAGE_DIR"
touch "$IMAGE_DIR/first-boot-required"
chmod 0644 "$IMAGE_DIR/first-boot-required"

log "Removing cloned identity and runtime residue"
rm -f /etc/ssh/ssh_host_*
rm -f /etc/machine-id /var/lib/dbus/machine-id
: >/home/multimedica_edge/kiosk-browser.log
rm -rf /home/multimedica_edge/kiosk-profile
journalctl --rotate 2>/dev/null || true
journalctl --vacuum-time=1s 2>/dev/null || true

sync
log "Image preparation complete"
log "Power off now. Do not boot this card again before capturing it."
log "Run: sudo systemctl poweroff"
