#!/usr/bin/env bash

set -euo pipefail

LOG_FILE="/home/multimedica_edge/kiosk-browser.log"
DISPLAY_URL="http://127.0.0.1:3001/"
CHROMIUM_READY_URL="http://127.0.0.1:9222/json/version"

export DISPLAY="${DISPLAY:-:0}"

touch "$LOG_FILE"
echo "==== Kiosk start $(date) ====" >> "$LOG_FILE"

# Wait for the local display server rather than opening Chromium on an error page.
for _attempt in $(seq 1 30); do
  if curl -fs --connect-timeout 2 --max-time 4 http://127.0.0.1:3001/api/health >/dev/null 2>&1; then
    break
  fi
  if [ "$_attempt" -eq 30 ]; then
    echo "ERROR: Display server did not become healthy." >&2
    exit 1
  fi
  sleep 1
done

# Keep startup visually stable without cycling panel power. This display can
# lose raster synchronization after DPMS force-off/force-on, producing a
# temporarily scrambled image. Keep the panel powered on with a black X root
# window until Chromium paints over it.
xsetroot -solid black >/dev/null 2>&1 || true
xset s off >/dev/null 2>&1 || true
xset -dpms >/dev/null 2>&1 || true
xset s noblank >/dev/null 2>&1 || true

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

# Launch Chromium with logging. The wrapper remains as the systemd main
# process so it can reveal the panel only after Chromium itself is responsive.
"$CHROMIUM_BIN" \
  --user-data-dir=/home/multimedica_edge/kiosk-profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --noerrdialogs \
  --disable-gpu \
  --disable-gpu-compositing \
  --disable-gpu-rasterization \
  --disable-accelerated-2d-canvas \
  --use-angle=swiftshader \
  --disable-features=Translate \
  --disable-restore-session-state \
  --overscroll-history-navigation=0 \
  --window-position=0,0 \
  --window-size=480,800 \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --start-fullscreen \
  --check-for-update-interval=31536000 \
  --enable-logging=stderr \
  --kiosk "$DISPLAY_URL" \
  >> "$LOG_FILE" 2>&1 &
CHROMIUM_PID=$!

cleanup() {
  if kill -0 "$CHROMIUM_PID" >/dev/null 2>&1; then
    kill "$CHROMIUM_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

for _attempt in $(seq 1 30); do
  if ! kill -0 "$CHROMIUM_PID" >/dev/null 2>&1; then
    echo "ERROR: Chromium exited before the kiosk became ready." >&2
    wait "$CHROMIUM_PID" || true
    exit 1
  fi
  if curl -fs --connect-timeout 2 --max-time 4 "$CHROMIUM_READY_URL" >/dev/null 2>&1; then
    break
  fi
  if [ "$_attempt" -eq 30 ]; then
    echo "ERROR: Chromium did not become ready." >&2
    exit 1
  fi
  sleep 1
done

# Allow the first kiosk frame to paint. The panel has remained powered with a
# stable black root window throughout startup.
sleep 1

wait "$CHROMIUM_PID"
