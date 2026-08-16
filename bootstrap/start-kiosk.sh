#!/usr/bin/env bash

set -euo pipefail

LOG_FILE="/home/multimedica_edge/kiosk-browser.log"
DISPLAY_URL="http://127.0.0.1:3001/"

export DISPLAY="${DISPLAY:-:0}"

touch "$LOG_FILE"
echo "==== Kiosk start $(date) ====" >> "$LOG_FILE"

# Wait for the local display server rather than opening Chromium on an error page.
for _attempt in $(seq 1 30); do
  if curl -fs http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    break
  fi
  if [ "$_attempt" -eq 30 ]; then
    echo "ERROR: Display server did not become healthy." >&2
    exit 1
  fi
  sleep 1
done

# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Optional: hide cursor
unclutter -idle 0.5 -root >> "$LOG_FILE" 2>&1 &

# Discover Chromium executable (path differs between Raspberry Pi OS versions)
CHROMIUM_BIN=""
for _candidate in chromium chromium-browser /usr/lib/chromium/chromium /usr/bin/chromium /usr/bin/chromium-browser; do
  if command -v "$_candidate" >/dev/null 2>&1; then
    CHROMIUM_BIN="$_candidate"
    break
  fi
done
if [ -z "$CHROMIUM_BIN" ]; then
  echo "ERROR: Chromium not found. Install chromium or chromium-browser." >&2
  exit 1
fi
echo "Using Chromium: $CHROMIUM_BIN" >> "$LOG_FILE"

# Launch Chromium with logging. exec keeps systemd tied to the browser process.
exec "$CHROMIUM_BIN" \
  --user-data-dir=/home/multimedica_edge/kiosk-profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --noerrdialogs \
  --disable-features=Translate \
  --disable-restore-session-state \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --enable-logging=stderr \
  --kiosk "$DISPLAY_URL" \
  >> "$LOG_FILE" 2>&1
