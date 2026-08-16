#!/usr/bin/env bash
# =============================================================================
# Multimedica Scanner — Bootstrap Installer
# =============================================================================
#
# Installs the Multimedica bootstrap layer on a Raspberry Pi 4.
# Must be run as root (sudo bash install-bootstrap.sh [OPTIONS]).
#
# Usage:
#   sudo bash install-bootstrap.sh \
#       --src       <source-dir>         # directory containing this script
#       --secrets   <transfer-file>      # temp JSON file with qr_admin_token
#       [--force]                        # overwrite existing bootstrap files
#
# The secrets transfer file contains exactly:
#   { "qr_admin_token": "<opaque-token>" }
#
# It is deleted (shred/rm) immediately after the token is installed.
# The token value is never echoed, logged, or passed via shell arguments.
#
# SECURITY REQUIREMENTS:
#   - secrets.json is owned root:multimedica_edge, mode 0640.
#   - config.json  is owned multimedica_edge:multimedica_edge, mode 0640.
#   - The token is consumed from the transfer file using node, not shell.
#   - Shell tracing (set -x) must not be active when secrets are handled.
#
# IDEMPOTENT:
#   - Re-running is safe.
#   - Existing valid config.json and secrets.json are preserved.
#   - Services are restarted only if installation succeeds.
#
# DOES NOT:
#   - Install or touch the production scanner (scanner.js / configQr.js).
#   - Require shared_secret or endpoint_url.
#   - Require cloud credentials beyond the bootstrap token.
#
# A clean Raspberry Pi OS image does require package-repository access during
# first installation so the bootstrap runtime dependencies can be installed.
# =============================================================================

set -euo pipefail

# --- defaults ---
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_FILE=""
FORCE=0

# --- paths ---
INSTALL_ROOT="/opt/multimedica-scanner"
BOOTSTRAP_DIR="$INSTALL_ROOT/bootstrap"
SCHEMAS_DIR="$INSTALL_ROOT/schemas"
STATE_DIR="/var/lib/multimedica-scanner/state"
SYSTEMD_DIR="/etc/systemd/system"
APP_USER="multimedica_edge"
APP_GROUP="multimedica_edge"
NODE_BIN="/usr/bin/node"
NPM_BIN="/usr/bin/npm"

# --- logging ---
log()  { echo "[bootstrap] $*"; }
warn() { echo "[bootstrap] WARNING: $*" >&2; }
fail() { echo "[bootstrap] ERROR: $*" >&2; exit 1; }

# --- argument parsing ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --src)       SRC_DIR="$2";       shift 2 ;;
    --secrets)   SECRETS_FILE="$2";  shift 2 ;;
    --force)     FORCE=1;            shift   ;;
    *) fail "Unknown option: $1" ;;
  esac
done

# --- preflight and clean-image runtime dependencies ---
[[ $EUID -eq 0 ]] || fail "Must be run as root"

MISSING_PACKAGES=()
[[ -x "$NODE_BIN" ]] || MISSING_PACKAGES+=(nodejs)
[[ -x "$NPM_BIN" ]]  || MISSING_PACKAGES+=(npm)
command -v rsync >/dev/null 2>&1 || MISSING_PACKAGES+=(rsync)
command -v curl  >/dev/null 2>&1 || MISSING_PACKAGES+=(curl)
command -v sudo  >/dev/null 2>&1 || MISSING_PACKAGES+=(sudo)
command -v evtest >/dev/null 2>&1 || MISSING_PACKAGES+=(evtest)
command -v Xorg  >/dev/null 2>&1 || MISSING_PACKAGES+=(xserver-xorg)
command -v xinit >/dev/null 2>&1 || MISSING_PACKAGES+=(xinit)
command -v xset  >/dev/null 2>&1 || MISSING_PACKAGES+=(x11-xserver-utils)
command -v unclutter >/dev/null 2>&1 || MISSING_PACKAGES+=(unclutter)
if ! command -v chromium >/dev/null 2>&1 && \
   ! command -v chromium-browser >/dev/null 2>&1 && \
   [[ ! -x /usr/lib/chromium/chromium ]]; then
  MISSING_PACKAGES+=(chromium)
fi

if [[ ${#MISSING_PACKAGES[@]} -gt 0 ]]; then
  command -v apt-get >/dev/null 2>&1 || fail "Required packages are missing and apt-get is unavailable: ${MISSING_PACKAGES[*]}"
  log "Installing clean-image prerequisites: ${MISSING_PACKAGES[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update || fail "apt-get update failed; verify Ethernet and package-repository access"
  apt-get install -y --no-install-recommends "${MISSING_PACKAGES[@]}" \
    || fail "Failed to install clean-image prerequisites: ${MISSING_PACKAGES[*]}"
fi

[[ -x "$NODE_BIN" ]] || fail "Node.js installation did not provide $NODE_BIN"
[[ -x "$NPM_BIN" ]]  || fail "npm installation did not provide $NPM_BIN"
command -v rsync >/dev/null 2>&1 || fail "rsync installation failed"
command -v curl  >/dev/null 2>&1 || fail "curl installation failed"
command -v sudo  >/dev/null 2>&1 || fail "sudo installation failed"
command -v evtest >/dev/null 2>&1 || fail "evtest installation failed"
command -v Xorg  >/dev/null 2>&1 || fail "Xorg installation failed"
command -v xinit >/dev/null 2>&1 || fail "xinit installation failed"
command -v xset  >/dev/null 2>&1 || fail "xset installation failed"
command -v unclutter >/dev/null 2>&1 || fail "unclutter installation failed"
if ! command -v chromium >/dev/null 2>&1 && \
   ! command -v chromium-browser >/dev/null 2>&1 && \
   [[ ! -x /usr/lib/chromium/chromium ]]; then
  fail "Chromium installation failed"
fi

[[ -f "$SRC_DIR/controller.js" ]] || fail "Source directory does not contain controller.js: $SRC_DIR"

# =============================================================================
# 1. Create user and directories
# =============================================================================

log "Creating user $APP_USER (if absent)"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system \
          --home-dir "/home/$APP_USER" \
          --create-home \
          --shell /bin/bash \
          "$APP_USER"
fi

# Barcode scanners expose /dev/input/event* as root:input. Grant only the
# supplementary device group required by the non-root controller service.
getent group input >/dev/null 2>&1 || groupadd --system input
usermod -a -G input "$APP_USER"

log "Creating state directory $STATE_DIR"
mkdir -p \
  "$STATE_DIR/backups" \
  "$STATE_DIR/releases/staging" \
  "$STATE_DIR/releases/transactions"
chown -R "$APP_USER:$APP_GROUP" "$STATE_DIR"
chmod 750 "$STATE_DIR"

log "Creating installation root $INSTALL_ROOT"
mkdir -p "$INSTALL_ROOT"
chown "$APP_USER:$APP_GROUP" "$INSTALL_ROOT"

# =============================================================================
# 2. Copy bootstrap application files
# =============================================================================

log "Copying bootstrap files to $BOOTSTRAP_DIR"
if [[ $FORCE -eq 1 && -d "$BOOTSTRAP_DIR" ]]; then
  rm -rf "$BOOTSTRAP_DIR"
fi
mkdir -p "$BOOTSTRAP_DIR"

# Copy bootstrap source (excluding test files and node_modules)
rsync -a --exclude='node_modules' --exclude='*.test.js' \
      "$SRC_DIR/" "$BOOTSTRAP_DIR/"

# Copy schemas (needed by AJV validators in config/secrets stores)
log "Copying schemas to $SCHEMAS_DIR"
mkdir -p "$SCHEMAS_DIR"
if [[ -d "$SRC_DIR/../schemas" ]]; then
  rsync -a "$SRC_DIR/../schemas/" "$SCHEMAS_DIR/"
fi

# Copy root package.json and lockfile for npm ci
if [[ -f "$SRC_DIR/../package.json" ]]; then
  cp "$SRC_DIR/../package.json"      "$INSTALL_ROOT/package.json"
fi
if [[ -f "$SRC_DIR/../package-lock.json" ]]; then
  cp "$SRC_DIR/../package-lock.json" "$INSTALL_ROOT/package-lock.json"
fi

chown -R "$APP_USER:$APP_GROUP" "$INSTALL_ROOT"
chmod -R u+rX,g+rX,o-rwx "$INSTALL_ROOT"
find "$INSTALL_ROOT" -name '*.sh' -exec chmod +x {} \;

# =============================================================================
# 3. Install npm dependencies
# =============================================================================

log "Installing npm dependencies in $INSTALL_ROOT"
pushd "$INSTALL_ROOT" >/dev/null
if [[ -f package-lock.json ]]; then
  sudo -u "$APP_USER" "$NPM_BIN" ci --omit=dev --prefer-offline 2>&1 | sed 's/^/[npm] /'
else
  sudo -u "$APP_USER" "$NPM_BIN" install --omit=dev 2>&1 | sed 's/^/[npm] /'
fi
popd >/dev/null

# =============================================================================
# 4. Install bootstrap secrets (qr_admin_token)
# =============================================================================
# SECURITY: set +x ensures no shell tracing during secret handling.
# The token is never passed as a shell argument — it is read via node.

if [[ -n "$SECRETS_FILE" && -f "$SECRETS_FILE" ]]; then
  set +x
  log "Installing bootstrap token from transfer file"

  # Validate the transfer file has exactly the expected key
  node -e "
const t = JSON.parse(require('fs').readFileSync('$SECRETS_FILE','utf8'));
if (!t.qr_admin_token || typeof t.qr_admin_token !== 'string') {
  process.stderr.write('ERROR: transfer file missing qr_admin_token string\\n');
  process.exit(1);
}
" || fail "Transfer file validation failed"

  # Use the secrets-store module to write the token atomically
  MULTIMEDICA_STATE_DIR="$STATE_DIR" node -e "
const s = require('$BOOTSTRAP_DIR/lib/secrets-store');
const t = JSON.parse(require('fs').readFileSync('$SECRETS_FILE','utf8'));
const r = s.writeSecrets({ qr_admin_token: t.qr_admin_token }, '$STATE_DIR');
if (!r || !r.ok) { process.stderr.write('ERROR: failed to write secrets\\n'); process.exit(1); }
" || fail "Failed to install bootstrap token"

  # Set permissions: root:multimedica_edge 0640
  chown root:"$APP_GROUP" "$STATE_DIR/secrets.json"
  chmod 0640 "$STATE_DIR/secrets.json"

  # Securely delete the transfer file
  if command -v shred >/dev/null 2>&1; then
    shred -u "$SECRETS_FILE"
  else
    rm -f "$SECRETS_FILE"
  fi
  log "Bootstrap token installed; transfer file deleted"
else
  if [[ ! -f "$STATE_DIR/secrets.json" ]]; then
    warn "No transfer file provided and no existing secrets.json — QR validation will fail until token is installed"
  else
    log "Existing secrets.json preserved"
  fi
fi

# =============================================================================
# 5. Initialise config.json (if not already present)
# =============================================================================

if [[ ! -f "$STATE_DIR/config.json" ]]; then
  log "Creating initial config.json"
  MULTIMEDICA_STATE_DIR="$STATE_DIR" node -e "
const c = require('$BOOTSTRAP_DIR/lib/config-store');
c.writeConfig({
  commissioning_state: 'bootstrap_installed',
  bootstrap_version:   '1.0.0',
  qr_schema_version:   1,
  config_schema_version: 1,
}, '$STATE_DIR');
" || fail "Failed to create initial config.json"
  chown "$APP_USER:$APP_GROUP" "$STATE_DIR/config.json"
  chmod 0640 "$STATE_DIR/config.json"
else
  log "Existing config.json preserved"
fi

# =============================================================================
# 6. Install and configure systemd units
# =============================================================================

UNIT_SRC="$BOOTSTRAP_DIR/systemd"

if [[ -d "$UNIT_SRC" ]]; then
  log "Installing systemd service units"

  # ==========================================================================
  # PORT 3001 CONFLICT CHECK
  # The bootstrap display service (multimedica-display.service) binds port 3001.
  # The legacy kiosk-display.service also uses port 3001.
  # We must NOT stop or disable legacy production services.
  #
  # Policy:
  #   - If kiosk-display.service is active, abort with a diagnostic.
  #   - If port 3001 is in use by anything else, abort with a diagnostic.
  #   - If port 3001 is free, proceed.
  # ==========================================================================

  if systemctl is-active --quiet kiosk-display.service 2>/dev/null; then
    fail "CONFLICT: kiosk-display.service is currently active on port 3001.
Bootstrap display service (multimedica-display.service) also needs port 3001.
Bootstrap installation cannot safely proceed while the legacy kiosk display is running.

If this is an EXISTING PRODUCTION SCANNER:
  Do not install the bootstrap layer without first migrating the production
  services to the new multimedica-* service model (later milestones).

If this is a CLEAN Raspberry Pi OS installation:
  Ensure kiosk-display.service is not installed or enabled before running bootstrap.
  'systemctl is-active kiosk-display.service' should return 'inactive' or 'not-found'.

The installer did NOT modify or stop any existing service."
  fi

  # Belt-and-suspenders: check if the port is in use by any process
  if ss -tlnp 2>/dev/null | grep -q ':3001 ' || netstat -tlnp 2>/dev/null | grep -q ':3001 '; then
    warn "Port 3001 appears to be in use. If multimedica-display.service fails to start, check for port conflicts."
  fi

  for svc in multimedica-controller.service \
             multimedica-display.service \
             multimedica-kiosk.service \
             multimedica-production.service; do
    if [[ -f "$UNIT_SRC/$svc" ]]; then
      cp "$UNIT_SRC/$svc" "$SYSTEMD_DIR/$svc"
      log "Installed $svc"
    fi
  done

  systemctl daemon-reload
fi

# =============================================================================
# 7. Enable and start bootstrap services
# =============================================================================

log "Enabling bootstrap services"
systemctl enable multimedica-display.service     2>/dev/null || true
systemctl enable multimedica-controller.service  2>/dev/null || true
systemctl enable multimedica-kiosk.service       2>/dev/null || true
# Production service is NOT enabled here — activated by Milestone 5
systemctl disable multimedica-production.service 2>/dev/null || true
# tty1 belongs to the appliance kiosk. SSH remains available for recovery.
systemctl disable getty@tty1.service             2>/dev/null || true

log "Starting display service"
systemctl restart multimedica-display.service

log "Starting controller service"
systemctl restart multimedica-controller.service

log "Starting physical kiosk service"
systemctl restart multimedica-kiosk.service

# =============================================================================
# 8. Post-install verification
# =============================================================================

log "Waiting for services to start..."
sleep 4

FAIL=0

for svc in multimedica-display.service multimedica-controller.service multimedica-kiosk.service; do
  if systemctl is-active --quiet "$svc"; then
    log "$svc is active"
  else
    warn "$svc is NOT active"
    systemctl status "$svc" --no-pager --lines=20 || true
    FAIL=1
  fi
done

# Check display health endpoint
DISPLAY_HEALTH=""
for _i in 1 2 3 4 5; do
  DISPLAY_HEALTH="$(curl -fs http://127.0.0.1:3001/api/health 2>/dev/null || true)"
  if [[ -n "$DISPLAY_HEALTH" ]]; then break; fi
  sleep 1
done

if [[ -n "$DISPLAY_HEALTH" ]]; then
  log "Display health endpoint responded"
else
  warn "Display health endpoint did not respond on port 3001"
  FAIL=1
fi

if [[ $FAIL -ne 0 ]]; then
  fail "Post-install verification failed — check journalctl -u multimedica-controller -u multimedica-display"
fi

log "Bootstrap installation complete"
