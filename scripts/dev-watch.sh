#!/usr/bin/env bash
# Inner dev loop:
#   1. Build with OWUI_DEBUG=1, which compiles a SELECT-in-IDLE short-circuit
#      that fires a canned utterance directly (see src/c/dictation.c). This is
#      the primary mechanism — no microphone needed, no `pebble transcribe`
#      required.
#   2. Also run `pebble transcribe` in the background as a fallback in case
#      the developer rebuilds without OWUI_DEBUG (e.g. testing real dictation
#      callbacks). With OWUI_DEBUG=1 the transcribe server is unused but
#      harmless.
#   3. Rebuild + reinstall on src/ or package.json change.
# Both stop on Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] && set -a && . ./.env.local && set +a
: "${EMU_PLATFORM:=emery}"
TRANSCRIPTION="${1:-what is the capital of france}"

# Inner loop always uses the in-app fake-dictation short-circuit. Emulator-only
# — never install a debug build to a paired watch.
export OWUI_DEBUG=1

if ! command -v pebble >/dev/null 2>&1; then
  echo "pebble-tool not on PATH. Install with: uv tool install pebble-tool --python 3.13"
  exit 1
fi

TRANSCRIBE_PID=""
cleanup() {
  if [ -n "$TRANSCRIBE_PID" ] && kill -0 "$TRANSCRIBE_PID" 2>/dev/null; then
    kill "$TRANSCRIBE_PID" 2>/dev/null || true
  fi
  # pebble-tool sometimes leaks qemu-pebble and pypkjs processes between
  # runs. Reap whatever was associated with this dev session. Use specific
  # patterns so we don't self-kill (pgrep -f matches whole command lines).
  pkill -9 -f 'qemu-pebble ' 2>/dev/null || true
  pkill -9 -f 'python.*pypkjs' 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Kill any rogue emulator processes left over from a previous abrupt exit.
if pgrep -f 'qemu-pebble ' >/dev/null 2>&1 || pgrep -f 'python.*pypkjs' >/dev/null 2>&1; then
  echo "=== killing leftover qemu-pebble/pypkjs from previous run ==="
  pkill -9 -f 'qemu-pebble ' 2>/dev/null || true
  pkill -9 -f 'python.*pypkjs' 2>/dev/null || true
  sleep 1
fi

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
