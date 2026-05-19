#!/usr/bin/env bash
# Capture a rollover GIF of the app for the appstore listing. Drives a
# chat turn in the OWUI_DEBUG build during the 7-second recording window so
# the GIF shows actual motion (idle -> spinner -> chat bubbles -> next turn)
# instead of a frozen idle screen.
#
# Prerequisites (host-side):
#   - X11 (not Wayland): pebble screenshot uses x11grab
#   - ffmpeg, ffprobe (encoding pipeline)
#   - xdotool, xwininfo (qemu-pebble window discovery)
#
# Output: appstore/screenshots/emery_demo.gif
#
# Tested on Linux. macOS users can run it too — pebble screenshot uses
# avfoundation there and xdotool/xwininfo aren't needed; this script's
# preflight check warns instead of bails on macOS.

set -euo pipefail
cd "$(dirname "$0")/.."

OUT=appstore/screenshots/emery_demo.gif
FAKE_PORT=3001

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31mx %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m+ %s\033[0m\n' "$*"; }

# ----- preflight --------------------------------------------------------
bold "preflight"
if [ "$(uname)" = "Linux" ]; then
  [ -n "${DISPLAY:-}" ] || fail "DISPLAY is unset. Run this from an X11 session (Wayland is not supported by pebble screenshot's x11grab path)."
  if [ -n "${WAYLAND_DISPLAY:-}" ]; then
    warn "Wayland detected. If x11grab fails, switch to an X11 session."
  fi
  for t in ffmpeg ffprobe xdotool xwininfo; do
    command -v "$t" >/dev/null 2>&1 || fail "missing: $t (apt: ffmpeg xdotool x11-utils)"
  done
fi
command -v pebble >/dev/null 2>&1 || fail "pebble-tool not on PATH"
ok "preflight passed"

# ----- reap stragglers --------------------------------------------------
bold "reap leftover emulator processes"
for pid in $(pidof qemu-pebble 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done
for pid in $(pidof python python3 2>/dev/null); do
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  case "$cmd" in *pypkjs*|*fake-owui*) kill -9 "$pid" 2>/dev/null || true ;;
  esac
done
sleep 1
ok "reaped"

cleanup() {
  for pid in "${FAKE_PID:-}" "${SHOT_PID:-}"; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
  done
  for pid in $(pidof qemu-pebble 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done
  for pid in $(pidof python python3 2>/dev/null); do
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
    case "$cmd" in *pypkjs*|*fake-owui*) kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
}
trap cleanup EXIT INT TERM

# ----- fake OWUI for deterministic replies -----------------------------
bold "start fake-owui"
python3 scripts/fake-owui.py >/tmp/fake-gif.log 2>&1 &
FAKE_PID=$!
n=0
while ! curl -sS -m 1 "http://localhost:${FAKE_PORT}/api/models" >/dev/null 2>&1; do
  sleep 0.3
  n=$((n + 1))
  [ "$n" -gt 30 ] && fail "fake-owui never came up; see /tmp/fake-gif.log"
done
ok "fake-owui listening on :$FAKE_PORT"

# ----- build + install with debug-dictation -----------------------------
bold "build OWUI_DEBUG=1 + install"
OWUI_HOST="http://localhost:${FAKE_PORT}" OWUI_KEY="" OWUI_MODEL=fake-model-a \
  bash scripts/seed-emulator-config.sh >/dev/null
OWUI_DEBUG=1 pebble build >/tmp/build-gif.log 2>&1 || { tail -30 /tmp/build-gif.log; fail "build failed"; }
pebble install --emulator emery >/dev/null 2>&1 || {
  sleep 4
  pebble install --emulator emery >/dev/null 2>&1 || fail "pebble install --emulator emery failed"
}
sleep 4
ok "emulator running with debug build"

# ----- kick off pebble screenshot --gif-all-platforms in background -----
# It primes the watch clock (~1s) then records for 7s. We watch its log
# for "Recording emulator window" to know when ffmpeg actually started.
mkdir -p appstore/screenshots
rm -f /tmp/emery_*.gif appstore/screenshots/emery_*.gif
LOG=/tmp/gif-capture.log
( cd /tmp && pebble screenshot --no-open --emulator emery --gif-all-platforms ) >"$LOG" 2>&1 &
SHOT_PID=$!
bold "wait for recording to start"
n=0
while ! grep -q 'Recording emulator window' "$LOG" 2>/dev/null; do
  sleep 0.2
  n=$((n + 1))
  [ "$n" -gt 100 ] && {
    cat "$LOG"
    fail "ffmpeg recording never started"
  }
  kill -0 "$SHOT_PID" 2>/dev/null || { cat "$LOG"; fail "screenshot tool died early"; }
done
ok "recording started"

# ----- inject clicks during the 7s recording window -------------------
# Pebble screenshot records for 7 seconds. We do:
#  t~+0.5s : click SELECT  -> dictation short-circuit fires, see SENDING/WAITING then SHOWING
#  t~+3.0s : click SELECT  -> second turn, again landing on SHOWING (different bubbles, since
#            debug_utterances cycles)
sleep 0.5
pebble emu-button --emulator emery click select >/dev/null 2>&1 || true
sleep 2.5
pebble emu-button --emulator emery click select >/dev/null 2>&1 || true

bold "wait for capture to finish"
wait "$SHOT_PID"
ok "capture done"

# ----- move output into appstore/screenshots/ --------------------------
shopt -s nullglob
GIFS=(/tmp/emery_*.gif)
if [ "${#GIFS[@]}" -eq 0 ]; then
  cat "$LOG"
  fail "no emery_*.gif produced"
fi
mv "${GIFS[0]}" "$OUT"
bold "done"
ls -la "$OUT"
echo
echo "Add to the publish bundle:  ${OUT}"
