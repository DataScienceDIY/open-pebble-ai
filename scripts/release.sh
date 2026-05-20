#!/usr/bin/env bash
# Build the publishable release .pbw — no baked secrets, real dictation.
#
# In order, this script:
#   1. Clears src/pkjs/config_defaults.js to an empty object. scripts/dev.sh
#      bakes .env.local (server URL + API key + model) in there for
#      development; clearing it means the published app ships unconfigured
#      and users enter their own endpoint via the in-app settings page.
#   2. Builds with OWUI_DEBUG unset, so real dictation is compiled in — no
#      canned-utterance short-circuit.
#   3. Verifies the bundled JS carries no leaked API key.
#
# Output: build/open-pebble-ai.pbw — ready to submit to the Rebble appstore
# (dev-portal.rebble.io) or sideload onto a real watch.

set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG_DEFAULTS=src/pkjs/config_defaults.js
PBW=build/open-pebble-ai.pbw
BUNDLE_JS=build/pebble-js-app.js

command -v pebble >/dev/null 2>&1 || {
  echo "pebble-tool not on PATH. Install: uv tool install pebble-tool --python 3.13" >&2
  exit 1
}

echo "=== clearing baked config ($CONFIG_DEFAULTS) ==="
cat > "$CONFIG_DEFAULTS" <<'EOF'
// Build-time config defaults. Empty for release builds: scripts/dev.sh
// bakes .env.local values here for development, scripts/release.sh clears
// it so no server URL or API key ships in the published app.
module.exports = {};
EOF

echo "=== clean release build (OWUI_DEBUG off) ==="
unset OWUI_DEBUG
pebble clean
pebble build

[ -f "$PBW" ] || { echo "build produced no $PBW" >&2; exit 1; }

# Safety net: refuse to call the build "release" if an API-key-shaped string
# slipped into the shipped JS bundle.
if [ -f "$BUNDLE_JS" ] && grep -Eq 'sk-[A-Za-z0-9]{16,}' "$BUNDLE_JS"; then
  echo "REFUSING: an 'sk-...' API key is present in $BUNDLE_JS" >&2
  exit 1
fi

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
echo
echo "=== release build OK ==="
echo "  artifact : $PBW"
echo "  version  : $VERSION"
echo "  next     : submit at dev-portal.rebble.io, or sideload onto a watch."
