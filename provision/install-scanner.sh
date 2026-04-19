#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/paullmullen/multimedica-scanner"
BRANCH="main"
INSTALL_DIR="/opt/multimedica-scanner"
SERVICE_NAME="multimedica-scanner"
DEFAULT_RUN_USER="multimedica_edge"

log() {
  echo "[install-scanner] $1"
}

require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    echo "Please run this installer with sudo."
    exit 1
  fi
}

detect_run_user() {
  if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
    echo "${SUDO_USER}"
    return
  fi

  if id -u "${DEFAULT_RUN_USER}" >/dev/null 2>&1; then
    echo "${DEFAULT_RUN_USER}"
    return
  fi

  echo "root"
}

install_base_packages() {
  log "Installing required packages..."

  apt-get update
  apt-get install -y git ca-certificates

  if ! command -v node >/dev/null 2>&1; then
    log "Node.js not found. Installing nodejs and npm from apt..."
    apt-get install -y nodejs npm
  fi
}

sync_repo() {
  local run_user="$1"

  mkdir -p "$(dirname "${INSTALL_DIR}")"

  if [ ! -d "${INSTALL_DIR}/.git" ]; then
    log "Cloning repository into ${INSTALL_DIR}..."
    git clone --branch "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
  else
    log "Repository already exists. Refreshing to origin/${BRANCH}..."
    git -C "${INSTALL_DIR}" fetch origin "${BRANCH}"
    git -C "${INSTALL_DIR}" checkout -B "${BRANCH}" "origin/${BRANCH}"
    git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
  fi

  chown -R "${run_user}:${run_user}" "${INSTALL_DIR}"
}

write_update_script() {
  local run_user="$1"

  log "Writing startup update checker..."

  mkdir -p "${INSTALL_DIR}/scripts"

  cat > "${INSTALL_DIR}/scripts/scanner-update-check.sh" <<'EOF'
#!/usr/bin/env bash
set -u

REPO_DIR="/opt/multimedica-scanner"
BRANCH="main"
REMOTE="origin"
SCANNER_FILE="scanner.js"

log() {
  echo "[scanner-update-check] $1"
}

log "Starting update check..."

if [ ! -d "${REPO_DIR}" ]; then
  log "Repo directory does not exist: ${REPO_DIR}"
  log "Skipping update check and allowing service startup."
  exit 0
fi

cd "${REPO_DIR}" || {
  log "Could not cd into repo directory: ${REPO_DIR}"
  log "Skipping update check and allowing service startup."
  exit 0
}

if [ ! -d ".git" ]; then
  log "Directory is not a git repository: ${REPO_DIR}"
  log "Skipping update check and allowing service startup."
  exit 0
fi

if [ ! -f "${SCANNER_FILE}" ]; then
  log "Scanner file not found: ${REPO_DIR}/${SCANNER_FILE}"
  log "Skipping update check and allowing service startup."
  exit 0
fi

LOCAL_COMMIT="$(git rev-parse HEAD 2>/dev/null)"
if [ -z "${LOCAL_COMMIT}" ]; then
  log "Could not determine local commit."
  log "Skipping update check and allowing service startup."
  exit 0
fi

REMOTE_LINE="$(git ls-remote --branches "${REMOTE}" "${BRANCH}" 2>/dev/null)"
if [ -z "${REMOTE_LINE}" ]; then
  log "Could not read remote branch '${BRANCH}' from '${REMOTE}'."
  log "Possible causes: no network, wrong branch name, or remote unavailable."
  log "Skipping update check and allowing service startup."
  exit 0
fi

REMOTE_COMMIT="$(echo "${REMOTE_LINE}" | awk '{print $1}')"

log "Local commit:  ${LOCAL_COMMIT}"
log "Remote commit: ${REMOTE_COMMIT}"

if [ "${LOCAL_COMMIT}" = "${REMOTE_COMMIT}" ]; then
  log "Already up to date."
  exit 0
fi

log "New version detected. Fetching updates..."
if ! git fetch "${REMOTE}" "${BRANCH}"; then
  log "git fetch failed."
  log "Keeping current local version and allowing service startup."
  exit 0
fi

if ! git checkout -B "${BRANCH}" "${REMOTE}/${BRANCH}"; then
  log "git checkout failed."
  log "Keeping current local version and allowing service startup."
  exit 0
fi

if ! git pull --ff-only "${REMOTE}" "${BRANCH}"; then
  log "git pull --ff-only failed."
  log "Keeping current local version and allowing service startup."
  exit 0
fi

if ! git reset --hard "${REMOTE}/${BRANCH}"; then
  log "git reset --hard failed."
  log "Keeping current local version and allowing service startup."
  exit 0
fi

NEW_LOCAL_COMMIT="$(git rev-parse HEAD 2>/dev/null)"
log "Update complete. New local commit: ${NEW_LOCAL_COMMIT}"

if [ ! -f "${SCANNER_FILE}" ]; then
  log "ERROR: scanner.js missing after update."
  log "Allowing service startup anyway, but scanner may fail."
  exit 0
fi

log "Update check finished successfully."
exit 0
EOF

  chmod +x "${INSTALL_DIR}/scripts/scanner-update-check.sh"
  chown "${run_user}:${run_user}" "${INSTALL_DIR}/scripts/scanner-update-check.sh"
}

write_service_file() {
  log "Writing systemd service file..."

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Multimedica Scanner Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${1}
WorkingDirectory=${INSTALL_DIR}
ExecStartPre=${INSTALL_DIR}/scripts/scanner-update-check.sh
ExecStart=/usr/bin/env node ${INSTALL_DIR}/scanner.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
}

install_node_dependencies() {
  local run_user="$1"

  log "Installing Node dependencies..."

  cd "${INSTALL_DIR}"

  if [ -f "package-lock.json" ]; then
    sudo -u "${run_user}" npm ci
  elif [ -f "package.json" ]; then
    sudo -u "${run_user}" npm install
  else
    log "No package.json found. Skipping npm install."
  fi
}

finalize_service() {
  log "Reloading systemd..."
  systemctl daemon-reload

  log "Enabling ${SERVICE_NAME}.service..."
  systemctl enable "${SERVICE_NAME}.service"

  if [ -f "${INSTALL_DIR}/.env" ]; then
    log ".env found. Restarting service..."
    systemctl restart "${SERVICE_NAME}.service"
  else
    log "No .env found yet at ${INSTALL_DIR}/.env"
    log "Service enabled but not started automatically."
    log "Copy .env into place, then run:"
    log "  sudo systemctl restart ${SERVICE_NAME}.service"
  fi
}

main() {
  require_root
  RUN_USER="$(detect_run_user)"

  log "Run user: ${RUN_USER}"
  log "Repo: ${REPO_URL}"
  log "Branch: ${BRANCH}"
  log "Install dir: ${INSTALL_DIR}"

  install_base_packages
  sync_repo "${RUN_USER}"
  write_update_script "${RUN_USER}"
  write_service_file "${RUN_USER}"
  install_node_dependencies "${RUN_USER}"
  finalize_service

  log "Installer completed successfully."
}

main "$@"