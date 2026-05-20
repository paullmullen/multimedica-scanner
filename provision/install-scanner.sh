#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-/home/multimedica_edge/provisioning}"
GIT_BRANCH="${2:-production}"
APP_DIR="/opt/multimedica-scanner"
APP_USER="multimedica_edge"
APP_GROUP="multimedica_edge"
SYSTEMD_DIR="/etc/systemd/system"
HOME_DIR="/home/${APP_USER}"
GIT_REPO_URL="https://github.com/paullmullen/multimedica-scanner.git"

log() {
  echo "==> $*"
}

require_safe_branch_name() {
  local branch="$1"

  # Keep this intentionally conservative for command-line deployment input.
  # Allows typical branch names like production, main, feature/qr-printing, release-2026-05.
  if [[ ! "$branch" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "ERROR: Invalid Git branch name: $branch" >&2
    exit 1
  fi

  if [[ "$branch" == /* || "$branch" == *..* || "$branch" == *//* || "$branch" == -* || "$branch" == *.lock ]]; then
    echo "ERROR: Unsafe Git branch name: $branch" >&2
    exit 1
  fi
}

log "Installing scanner bundle from: $SOURCE_DIR"
log "Target app dir: $APP_DIR"
log "Git repo: $GIT_REPO_URL"
log "Git branch: $GIT_BRANCH"

require_safe_branch_name "$GIT_BRANCH"

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "User $APP_USER does not exist. Create it first or adjust APP_USER in install-scanner.sh." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git not found. Install git on the Pi before provisioning." >&2
  exit 1
fi

# =========================
# GIT-BACKED APPLICATION INSTALL
# =========================

if [ -d "$APP_DIR/.git" ]; then
  log "Existing git-backed app directory detected"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

  pushd "$APP_DIR" >/dev/null

  log "Ensuring repository remote is correct"
  if sudo -u "$APP_USER" git remote get-url origin >/dev/null 2>&1; then
    sudo -u "$APP_USER" git remote set-url origin "$GIT_REPO_URL"
  else
    sudo -u "$APP_USER" git remote add origin "$GIT_REPO_URL"
  fi

  log "Fetching latest branch from origin"

  if sudo -u "$APP_USER" git fetch origin "$GIT_BRANCH"; then
    log "Checking out local branch: $GIT_BRANCH"

    if sudo -u "$APP_USER" git show-ref --verify --quiet "refs/heads/$GIT_BRANCH"; then
      sudo -u "$APP_USER" git checkout "$GIT_BRANCH"
    else
      sudo -u "$APP_USER" git checkout -b "$GIT_BRANCH" "origin/$GIT_BRANCH"
    fi

    log "Resetting local checkout to origin/$GIT_BRANCH"
    sudo -u "$APP_USER" git reset --hard "origin/$GIT_BRANCH"

    log "Cleaning untracked files"
    sudo -u "$APP_USER" git clean -fd
  else
    echo "WARNING: Could not fetch origin/$GIT_BRANCH. Continuing with currently installed local code." >&2
  fi

  popd >/dev/null
else
  log "No git-backed app directory found"

  if [ -d "$APP_DIR" ]; then
    BACKUP_DIR="${APP_DIR}.backup-$(date +%Y%m%d-%H%M%S)"
    log "Backing up existing app directory to: $BACKUP_DIR"
    mv "$APP_DIR" "$BACKUP_DIR"
  fi

  log "Preparing empty app directory for clone"
  mkdir -p "$APP_DIR"
  chown "$APP_USER:$APP_GROUP" "$APP_DIR"

  log "Cloning branch '$GIT_BRANCH' from GitHub"
  sudo -u "$APP_USER" git clone -b "$GIT_BRANCH" "$GIT_REPO_URL" "$APP_DIR"
fi

# =========================
# LOCAL DEVICE-SPECIFIC FILES
# =========================

# Runtime application files are now authoritative from GitHub.
# Keep only local/provisioning files that are intentionally device-specific
# or host-level configuration.

if [ -f "$SOURCE_DIR/.bash_profile" ]; then
  log "Installing generated .bash_profile"
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
      sudo -u "$APP_USER" npm ci --omit=dev
    else
      sudo -u "$APP_USER" npm install --omit=dev
    fi
    popd >/dev/null
  fi

  if [ -f "$APP_DIR/kiosk-display/package.json" ]; then
    log "Installing kiosk-display npm dependencies"
    pushd "$APP_DIR/kiosk-display" >/dev/null
    if [ -f package-lock.json ]; then
      sudo -u "$APP_USER" npm ci --omit=dev
    else
      sudo -u "$APP_USER" npm install --omit=dev
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
chmod 0700 "$HOME_DIR/scanner"

if [ -f "$HOME_DIR/scanner/.env" ]; then
  log "Existing persistent .env found; preserving device-specific configuration"
  chown "$APP_USER:$APP_GROUP" "$HOME_DIR/scanner/.env"
  chmod 0600 "$HOME_DIR/scanner/.env"
elif [ -f "$SOURCE_DIR/.env" ]; then
  log "Installing initial .env to persistent config directory"
  cp "$SOURCE_DIR/.env" "$HOME_DIR/scanner/.env"
  chown "$APP_USER:$APP_GROUP" "$HOME_DIR/scanner/.env"
  chmod 0600 "$HOME_DIR/scanner/.env"
else
  log "No .env found in source bundle; skipping initial .env install"
fi

# =========================
# SUDOERS
# =========================

log "Installing scanner sudoers rules"
cat >/etc/sudoers.d/multimedica-scanner <<'SUDOERS'
multimedica_edge ALL=(ALL) NOPASSWD:ALL
SUDOERS

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

log "Checking git repository status"
pushd "$APP_DIR" >/dev/null
CURRENT_BRANCH="$(sudo -u "$APP_USER" git branch --show-current)"
CURRENT_COMMIT="$(sudo -u "$APP_USER" git log -1 --oneline)"
echo "Current branch: $CURRENT_BRANCH"
echo "Current commit: $CURRENT_COMMIT"

if [ "$CURRENT_BRANCH" != "$GIT_BRANCH" ]; then
  echo "ERROR: Expected branch '$GIT_BRANCH' but found '$CURRENT_BRANCH'." >&2
  exit 1
fi
popd >/dev/null

log "Checking sudoers syntax"
visudo -c

log "Checking scanner sudo access to evtest"
sudo -u "$APP_USER" sudo -n -l /usr/bin/evtest >/dev/null 2>&1 || {
  echo "ERROR: $APP_USER cannot run sudo /usr/bin/evtest without password." >&2
  exit 1
}

log "Checking scanner sudo access to nmcli"
sudo -u "$APP_USER" sudo -n -l /usr/bin/nmcli >/dev/null 2>&1 || {
  echo "ERROR: $APP_USER cannot run sudo /usr/bin/nmcli without password." >&2
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

DISPLAY_HEALTH_OK=false

for i in {1..10}; do
  if curl -fsS http://127.0.0.1:3001/api/display >/dev/null 2>&1; then
    DISPLAY_HEALTH_OK=true
    break
  fi

  sleep 1
done

if [ "$DISPLAY_HEALTH_OK" = true ]; then
  log "Kiosk display health endpoint responded successfully"
else
  echo "WARNING: kiosk display health endpoint did not respond successfully."
fi

log "Post-install validation complete"
log "Installation complete"
