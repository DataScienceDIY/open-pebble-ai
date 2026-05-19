#!/usr/bin/env bash
# Wrapper around `pebble publish` that feeds it the assets prepared in
# this folder. Does NOT publish by default — run with --confirm to actually
# upload. Without --confirm it prints what it WOULD send (dry-run).
#
# Prereqs:
#   - You're signed in to the Pebble appstore via pebble-tool (set
#     PEBBLE_FIREBASE_ID_TOKEN, or omit --firebase-id-token for an
#     interactive login flow).
#   - A release-quality .pbw is built (`./scripts/inject-config-defaults.sh
#     --clear && pebble build`). The --clear is important: you don't want
#     to ship your own .env.local API key in the bundle that lands in
#     other users' watches.

set -euo pipefail
cd "$(dirname "$0")/.."

CONFIRM=0
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=1 ;;
  esac
done

CATEGORY=tools
NAME="Open Pebble AI"
VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
DESCRIPTION=$(cat appstore/description.txt)
RELEASE_NOTES=$(cat appstore/release-notes.txt)
ICON_SMALL=appstore/icons/icon-small.png
ICON_LARGE=appstore/icons/icon-large.png
SOURCE=""  # public repo URL; set via env $SOURCE or fill in here

if [ -z "$SOURCE" ] && [ -d .git ]; then
  SOURCE=$(git config --get remote.origin.url 2>/dev/null || true)
fi

# Sanity-check the .pbw doesn't carry baked secrets.
if grep -q '"apiKey": "sk-' src/pkjs/config_defaults.js 2>/dev/null; then
  cat >&2 <<'WARN'
WARNING: src/pkjs/config_defaults.js looks like it has a baked API key.
        Publishing this would ship your personal credential to every user.
        Run `./scripts/inject-config-defaults.sh --clear && pebble build`
        before publishing.
WARN
  exit 1
fi

# Collect screenshots. Filenames must start with the platform name; we name
# them `<platform>_*.png` so `pebble publish` routes them correctly.
SCREENSHOTS=()
for f in appstore/screenshots/emery_*.png appstore/screenshots/emery_*.gif; do
  [ -f "$f" ] && SCREENSHOTS+=("$f")
done

echo "Publish plan:"
echo "  name        : $NAME"
echo "  version     : $VERSION"
echo "  category    : $CATEGORY"
echo "  source      : ${SOURCE:-<unset>}"
echo "  icon-small  : $ICON_SMALL"
echo "  icon-large  : $ICON_LARGE"
echo "  screenshots : ${SCREENSHOTS[*]:-<none>}"
echo
echo "Description (first 200 chars):"
echo "  ${DESCRIPTION:0:200}..."
echo
echo "Release notes:"
sed 's/^/  /' appstore/release-notes.txt
echo

if [ "$CONFIRM" -ne 1 ]; then
  echo "DRY RUN — re-run with --confirm to actually publish."
  echo "Equivalent command (paste to skip this wrapper):"
  echo
  printf '  pebble publish --non-interactive \\\n'
  printf '    --name %q \\\n' "$NAME"
  printf '    --version %q \\\n' "$VERSION"
  printf '    --description %q \\\n' "$DESCRIPTION"
  printf '    --category %q \\\n' "$CATEGORY"
  printf '    --icon-small %q \\\n' "$ICON_SMALL"
  printf '    --icon-large %q \\\n' "$ICON_LARGE"
  [ -n "$SOURCE" ] && printf '    --source %q \\\n' "$SOURCE"
  printf '    --release-notes %q \\\n' "$RELEASE_NOTES"
  printf '    --no-gif-all-platforms \\\n'
  printf '    --screenshots'
  for s in "${SCREENSHOTS[@]}"; do printf ' %q' "$s"; done
  printf '\n'
  exit 0
fi

# Real publish path.
pebble publish --non-interactive \
  --name "$NAME" \
  --version "$VERSION" \
  --description "$DESCRIPTION" \
  --category "$CATEGORY" \
  --icon-small "$ICON_SMALL" \
  --icon-large "$ICON_LARGE" \
  ${SOURCE:+--source "$SOURCE"} \
  --release-notes "$RELEASE_NOTES" \
  --no-gif-all-platforms \
  --screenshots "${SCREENSHOTS[@]}"
