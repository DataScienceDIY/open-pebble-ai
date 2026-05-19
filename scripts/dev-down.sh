#!/usr/bin/env bash
# Stop the local OWUI/Ollama docker stack AND kill any leaked emulator
# processes (qemu-pebble, pypkjs). pebble-tool can accumulate these across
# runs; this script is a one-shot reaper.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f docker-compose.yml ] && command -v docker >/dev/null 2>&1; then
  docker compose down 2>/dev/null || true
fi

if pgrep -f 'qemu-pebble ' >/dev/null 2>&1 || pgrep -f 'python.*pypkjs' >/dev/null 2>&1; then
  echo "killing leftover qemu-pebble/pypkjs..."
  pkill -9 -f 'qemu-pebble ' 2>/dev/null || true
  pkill -9 -f 'python.*pypkjs' 2>/dev/null || true
fi
echo "down."
