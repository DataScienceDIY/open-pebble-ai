#!/usr/bin/env bash
# Inner dev loop:
#   1. Run `pebble transcribe` in the background — a persistent voice server
#      that answers every dictation_session_start() call with a canned string.
#   2. Build + install on src/ or package.json change.
# Both stop on Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] && set -a && . ./.env.local && set +a
: "${EMU_PLATFORM:=emery}"
TRANSCRIPTION="${1:-what is the capital of france}"

if ! command -v pebble >/dev/null 2>&1; then
  echo "pebble-tool not on PATH. Install with: uv tool install pebble-tool --python 3.13"
  exit 1
fi

TRANSCRIBE_PID=""
cleanup() {
  if [ -n "$TRANSCRIBE_PID" ] && kill -0 "$TRANSCRIBE_PID" 2>/dev/null; then
    kill "$TRANSCRIBE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "=== initial build + install ==="
pebble build
pebble install --emulator "$EMU_PLATFORM"

echo "=== starting pebble transcribe server (transcription: \"$TRANSCRIPTION\") ==="
pebble transcribe --emulator "$EMU_PLATFORM" "$TRANSCRIPTION" &
TRANSCRIBE_PID=$!

watcher() {
  if command -v fswatch >/dev/null 2>&1; then
    fswatch -o src/ package.json
  elif command -v inotifywait >/dev/null 2>&1; then
    while inotifywait -qqre modify,create,delete src/ package.json 2>/dev/null; do echo .; done
  else
    echo "No fswatch/inotifywait — falling back to 2s polling." >&2
    touch /tmp/.owui-build
    while :; do
      if find src/ package.json -newer /tmp/.owui-build 2>/dev/null | grep -q .; then
        echo .
        touch /tmp/.owui-build
      fi
      sleep 2
    done
  fi
}

echo "=== watching for changes; press SELECT in emulator to dictate ==="
watcher | while read -r _; do
  echo "=== rebuild ==="
  pebble build && pebble install --emulator "$EMU_PLATFORM" || echo "(build failed; will retry on next change)"
done
