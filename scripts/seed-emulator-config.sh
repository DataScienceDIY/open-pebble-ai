#!/usr/bin/env bash
# Seeds the emulator's PKJS localStorage with config drawn from .env.local.
# Use this once after `pebble install --emulator emery` (or any `pebble wipe`)
# so the watch app starts pre-configured instead of needing the webview
# config page filled in by hand.
#
# Reads:
#   OWUI_HOST       -> serverUrl
#   OWUI_KEY        -> apiKey
#   OWUI_MODEL      -> model
#   OWUI_SYSTEM_PROMPT (optional) -> systemPrompt
#
# Reads UUID from package.json. Targets the SDK in `pebble sdk` active output.

set -euo pipefail
cd "$(dirname "$0")/.."

# Inline env vars take precedence over .env.local — callers (e.g. the
# state-machine harness) can point the watch at a stub server without editing
# the user's real config. "Set" is checked rather than "non-empty" so passing
# OWUI_KEY="" works for the no-auth fake server.
for var in OWUI_HOST OWUI_KEY OWUI_MODEL EMU_PLATFORM OWUI_SYSTEM_PROMPT; do
  if [ -n "${!var+x}" ]; then
    eval "EXT_${var}_set=1; EXT_${var}=\"\$${var}\""
  fi
done

if [ -f .env.local ]; then
  set -a; . ./.env.local; set +a
fi

for var in OWUI_HOST OWUI_KEY OWUI_MODEL EMU_PLATFORM OWUI_SYSTEM_PROMPT; do
  if [ -n "$(eval echo \${EXT_${var}_set:-})" ]; then
    eval "${var}=\"\$EXT_${var}\""
  fi
done

: "${OWUI_HOST:?Set OWUI_HOST in .env.local or pass it inline}"
: "${OWUI_KEY:=}"
: "${OWUI_MODEL:?Set OWUI_MODEL in .env.local or pass it inline}"
: "${EMU_PLATFORM:=emery}"

UUID=$(python3 -c "import json; print(json.load(open('package.json'))['pebble']['uuid'])")
SDK_VER=$(pebble sdk list 2>/dev/null | awk '/\(active\)/ {print $1; exit}')
: "${SDK_VER:?Could not detect active SDK via pebble sdk list}"

DB_PATH="$HOME/.pebble-sdk/$SDK_VER/$EMU_PLATFORM/localstorage/$UUID"

DEFAULT_PROMPT='Keep responses very brief, a couple sentences at most. The user is reading this on a tiny smartwatch screen.'

python3 - <<PYEOF
import dbm.dumb, json, os, pathlib
db_path = "$DB_PATH"
pathlib.Path(os.path.dirname(db_path)).mkdir(parents=True, exist_ok=True)
cfg = {
    "serverUrl":    os.environ["OWUI_HOST"],
    "apiKey":       os.environ.get("OWUI_KEY", ""),
    "model":        os.environ["OWUI_MODEL"],
    "systemPrompt": os.environ.get("OWUI_SYSTEM_PROMPT") or """$DEFAULT_PROMPT""",
}
with dbm.dumb.open(db_path, "c") as db:
    db["owui_config"] = json.dumps(cfg)
print("seeded:", db_path)
print("  serverUrl =", cfg["serverUrl"])
print("  model     =", cfg["model"])
print("  apiKey    =", "<set>" if cfg["apiKey"] else "<blank>")
PYEOF
