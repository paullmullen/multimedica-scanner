#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-/home/multimedica_edge/provisioning}"
APP_DIR="/opt/multimedica-scanner"
APP_USER="multimedica_edge"
APP_GROUP="multimedica_edge"
SYSTEMD_DIR="/etc/systemd/system"
HOME_DIR="/home/${APP_USER}"

log() {
  echo "==> $*"
}

copy_if_exists() {
  local src="$1"
  local dest="$2"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    cp -R "$src" "$dest"
  fi
}

log "Installing scanner bundle from: $SOURCE_DIR"
log "Target app dir: $APP_DIR"

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "User $APP_USER does not exist. Create it first or adjust APP_USER in install-scanner.sh." >&2
  exit 1
fi

mkdir -p "$APP_DIR"
mkdir -p "$APP_DIR/kiosk"

# =========================
# COPY FILES
# =========================

log "Copying scanner runtime files"
copy_if_exists "$SOURCE_DIR/scanner.js" "$APP_DIR/scanner.js"
copy_if_exists "$SOURCE_DIR/configQr.js" "$APP_DIR/configQr.js"
copy_if_exists "$SOURCE_DIR/package.json" "$APP_DIR/package.json"
copy_if_exists "$SOURCE_DIR/package-lock.json" "$APP_DIR/package-lock.json"
copy_if_exists "$SOURCE_DIR/update-scanner.sh" "$APP_DIR/update-scanner.sh"

if [ -d "$SOURCE_DIR/kiosk" ]; then
  rm -rf "$APP_DIR/kiosk"
  cp -R "$SOURCE_DIR/kiosk" "$APP_DIR/kiosk"
fi

if [ -d "$SOURCE_DIR/kiosk-display" ]; then
  rm -rf "$APP_DIR/kiosk-display"
  cp -R "$SOURCE_DIR/kiosk-display" "$APP_DIR/kiosk-display"
fi

if [ -f "$SOURCE_DIR/.bash_profile" ]; then
  log "Installing .bash_profile"
  cp "$SOURCE_DIR/.bash_profile" "$HOME_DIR/.bash_profile"
  chown "$APP_USER:$APP_GROUP" "$HOME_DIR/.bash_profile"
fi

# =========================
# PERMISSIONS
# =========================

log "Setting ownership and permissions"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
find "$APP_DIR" -type f -name '*.sh' -exec chmod +x {} \;

# =========================
# NPM INSTALL
# =========================

if command -v npm >/dev/null 2>&1; then
  if [ -f "$APP_DIR/package.json" ]; then
    log "Installing scanner npm dependencies"
    pushd "$APP_DIR" >/dev/null
    if [ -f package-lock.json ]; then
      sudo -u "$APP_USER" npm ci
    else
      sudo -u "$APP_USER" npm install
    fi
    popd >/dev/null
  fi

  if [ -f "$APP_DIR/kiosk-display/package.json" ]; then
    log "Installing kiosk-display npm dependencies"
    pushd "$APP_DIR/kiosk-display" >/dev/null
    if [ -f package-lock.json ]; then
      sudo -u "$APP_USER" npm ci
    else
      sudo -u "$APP_USER" npm install
    fi
    popd >/dev/null
  fi
else
  echo "npm not found. Install Node.js/npm on the Pi before provisioning." >&2
  exit 1
fi

# =========================
# SYSTEMD INSTALL
# =========================

if [ -d "$SOURCE_DIR/systemd" ]; then
  log "Installing systemd unit files"
  find "$SOURCE_DIR/systemd" -maxdepth 1 -type f -name '*.service' -print0 | while IFS= read -r -d '' unit; do
    cp "$unit" "$SYSTEMD_DIR/$(basename "$unit")"
  done
fi

# Remove legacy kiosk.service
if [ -f "$SYSTEMD_DIR/kiosk.service" ]; then
  log "Removing legacy kiosk.service"
  systemctl disable kiosk.service || true
  systemctl stop kiosk.service || true
  rm -f "$SYSTEMD_DIR/kiosk.service"
  rm -f /etc/systemd/system/graphical.target.wants/kiosk.service
  rm -f /etc/systemd/system/multi-user.target.wants/kiosk.service
fi

# Remove legacy scanner.service
if systemctl list-unit-files | grep -q '^scanner.service'; then
  log "Removing legacy scanner.service"
  systemctl disable --now scanner.service 2>/dev/null || true
  systemctl reset-failed scanner.service 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/scanner.service"
  rm -f /etc/systemd/system/multi-user.target.wants/scanner.service
fi

# =========================
# PERSISTENT CONFIG
# =========================

log "Preparing persistent scanner config directory"
mkdir -p "$HOME_DIR/scanner"
chown -R "$APP_USER:$APP_GROUP" "$HOME_DIR/scanner"

if [ -f "$SOURCE_DIR/.env" ]; then
  log "Installing .env to persistent config directory"
  cp "$SOURCE_DIR/.env" "$HOME_DIR/scanner/.env"
  chown "$APP_USER:$APP_GROUP" "$HOME_DIR/scanner/.env"
  chmod 0600 "$HOME_DIR/scanner/.env"
fi

# =========================
# SUDOERS
# =========================

log "Installing scanner sudoers rules"
cat >/etc/sudoers.d/multimedica-scanner <<'EOF'
multimedica_edge ALL=(root) NOPASSWD: /usr/bin/evtest
multimedica_edge ALL=(root) NOPASSWD: /usr/bin/nmcli
EOF

chown root:root /etc/sudoers.d/multimedica-scanner
chmod 0440 /etc/sudoers.d/multimedica-scanner
visudo -c

# =========================
# START SERVICES
# =========================

log "Reloading systemd"
systemctl daemon-reload

for svc in multimedica-scanner.service kiosk-display.service; do
  if [ -f "$SYSTEMD_DIR/$svc" ]; then
    log "Enabling $svc"
    systemctl enable "$svc"
  fi
done

for svc in multimedica-scanner.service kiosk-display.service; do
  if [ -f "$SYSTEMD_DIR/$svc" ]; then
    log "Restarting $svc"
    systemctl restart "$svc"
  fi
done

# =========================
# POST-INSTALL VALIDATION
# =========================

log "Running post-install validation"

log "Checking sudoers syntax"
visudo -c

log "Checking scanner sudo access to evtest"
sudo -u "$APP_USER" sudo -n /usr/bin/evtest --help >/dev/null 2>&1 || {
  echo "ERROR: $APP_USER cannot run sudo evtest without password." >&2
  exit 1
}

log "Checking scanner sudo access to nmcli"
sudo -u "$APP_USER" sudo -n /usr/bin/nmcli dev status >/dev/null || {
  echo "ERROR: $APP_USER cannot run sudo nmcli without password." >&2
  exit 1
}

log "Checking multimedica-scanner.service"
systemctl is-active --quiet multimedica-scanner.service || {
  echo "ERROR: multimedica-scanner.service is not active." >&2
  systemctl status multimedica-scanner.service --no-pager || true
  exit 1
}

log "Checking kiosk-display.service"
systemctl is-active --quiet kiosk-display.service || {
  echo "ERROR: kiosk-display.service is not active." >&2
  systemctl status kiosk-display.service --no-pager || true
  exit 1
}

log "Checking local display health endpoint"
if command -v curl >/dev/null 2>&1; then
  curl -fsS http://127.0.0.1:3001/api/status/health >/dev/null || {
    echo "WARNING: kiosk display health endpoint did not respond successfully." >&2
  }
else
  echo "WARNING: curl not found; skipping display health check." >&2
fi

log "Post-install validation complete"

log "Installation complete"