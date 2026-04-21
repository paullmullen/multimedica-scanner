#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-/home/multimedica_edge/provisioning}"
APP_DIR="/opt/multimedica-scanner"
APP_USER="multimedica_edge"
APP_GROUP="multimedica_edge"
SYSTEMD_DIR="/etc/systemd/system"

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

if [ -f "$SOURCE_DIR/.env" ]; then
  log "Installing .env"
  cp "$SOURCE_DIR/.env" "$APP_DIR/.env"
fi

log "Setting ownership and permissions"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
find "$APP_DIR" -type f -name '*.sh' -exec chmod +x {} \;

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

if [ -d "$SOURCE_DIR/systemd" ]; then
  log "Installing systemd unit files"
  find "$SOURCE_DIR/systemd" -maxdepth 1 -type f -name '*.service' -print0 | while IFS= read -r -d '' unit; do
    cp "$unit" "$SYSTEMD_DIR/$(basename "$unit")"
  done
fi

log "Reloading systemd"
systemctl daemon-reload

for svc in multimedica-scanner.service kiosk-display.service kiosk.service; do
  if [ -f "$SYSTEMD_DIR/$svc" ]; then
    log "Enabling $svc"
    systemctl enable "$svc"
  fi
done

for svc in multimedica-scanner.service kiosk-display.service kiosk.service; do
  if [ -f "$SYSTEMD_DIR/$svc" ]; then
    log "Restarting $svc"
    systemctl restart "$svc"
  fi
done

log "Installation complete"
