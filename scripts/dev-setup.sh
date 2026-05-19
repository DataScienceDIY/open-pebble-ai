#!/usr/bin/env bash
# One-shot dev environment setup. Idempotent — safe to re-run.
#
# Installs the host-side toolchain needed to build, emulate, and deploy:
#   - uv (Python tooling launcher)
#   - pebble-tool (Pebble SDK CLI)
#   - The Pebble SDK itself (ARM toolchain, headers, emulator binaries)
#
# Does NOT touch the OWUI/Ollama Docker stack (run scripts/dev-up.sh for that)
# and does NOT modify your shell config — uv's installer prints PATH hints if
# ~/.local/bin isn't already on your PATH.

set -euo pipefail
cd "$(dirname "$0")/.."

step()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
note()  { printf '  %s\n' "$*"; }
warn()  { printf '\033[33m  ! %s\033[0m\n' "$*"; }
fail()  { printf '\033[31m  x %s\033[0m\n' "$*" >&2; exit 1; }
ok()    { printf '\033[32m  + %s\033[0m\n' "$*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_cmd curl

# Make sure PATH includes the common uv install dir even if the user hasn't
# yet sourced their shell config. uv puts binaries in ~/.local/bin.
export PATH="$HOME/.local/bin:${PATH}"

# ----------------------------------------------------------------------
step "Node.js + npm"
# pebble sdk install runs `npm install` for its JS resource pipeline and
# bails with "You must have npm >= 3.0.0" if npm isn't on PATH. We check
# upfront so the user doesn't get a half-installed SDK with cryptic errors.
if command -v npm >/dev/null 2>&1; then
  NPM_VER=$(npm --version 2>/dev/null)
  ok "npm $NPM_VER on PATH"
else
  warn "npm not found. The Pebble SDK install needs npm >= 3.0.0."
  echo "  Install Node.js (any LTS, 18+ is fine) with one of:"
  echo
  echo "    # User-local, no sudo (Linux/macOS):"
  echo "    curl -fsSL https://fnm.vercel.app/install | bash"
  echo "    exec \$SHELL  # then:"
  echo "    fnm install --lts && fnm use lts-latest"
  echo
  echo "    # macOS:"
  echo "    brew install node"
  echo
  echo "    # Debian/Ubuntu:"
  echo "    sudo apt install -y nodejs npm"
  echo
  echo "    # Fedora/RHEL:"
  echo "    sudo dnf install -y nodejs"
  echo
  fail "install npm and re-run this script"
fi

# ----------------------------------------------------------------------
step "uv"
if command -v uv >/dev/null 2>&1; then
  ok "uv already installed ($(uv --version 2>/dev/null | head -1))"
else
  note "installing uv via the official one-liner..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  if ! command -v uv >/dev/null 2>&1; then
    fail "uv install completed but 'uv' is not on PATH. Add \$HOME/.local/bin to PATH and re-run."
  fi
  ok "installed $(uv --version 2>/dev/null | head -1)"
fi

# ----------------------------------------------------------------------
step "pebble-tool"
if command -v pebble >/dev/null 2>&1; then
  ok "pebble-tool already installed ($(pebble --version 2>/dev/null | head -1))"
else
  note "installing pebble-tool with Python 3.13..."
  uv tool install pebble-tool --python 3.13
  if ! command -v pebble >/dev/null 2>&1; then
    fail "pebble-tool install completed but 'pebble' is not on PATH. uv installs to \$HOME/.local/bin — make sure that's on PATH."
  fi
  ok "installed $(pebble --version 2>/dev/null | head -1)"
fi

# ----------------------------------------------------------------------
step "Pebble SDK"
SDK_LIST=$(pebble sdk list 2>/dev/null || true)
if echo "$SDK_LIST" | grep -q '(active)'; then
  ACTIVE=$(echo "$SDK_LIST" | awk '/\(active\)/ {print $1; exit}')
  ok "Pebble SDK $ACTIVE already installed and active"
else
  note "installing the latest Pebble SDK (downloads ~150MB; bundles ARM toolchain + emulator)..."
  pebble sdk install latest
  ACTIVE=$(pebble sdk list 2>/dev/null | awk '/\(active\)/ {print $1; exit}')
  [ -n "$ACTIVE" ] || fail "Pebble SDK install ran but no active SDK is reported by 'pebble sdk list'."
  ok "installed Pebble SDK $ACTIVE"
fi

# ----------------------------------------------------------------------
step ".env.local"
if [ -f .env.local ]; then
  ok ".env.local already exists; not overwriting"
elif [ -f .env.local.example ]; then
  cp .env.local.example .env.local
  ok "seeded .env.local from .env.local.example — edit it before running scripts/dev-hardware.sh"
else
  warn ".env.local.example is missing; nothing to copy"
fi

# ----------------------------------------------------------------------
step "src/pkjs/config_defaults.js"
# config.js does require('./config_defaults') at bundle time, so the file
# must exist or webpack fails. It's gitignored — generate a stub on first
# setup. The developer can re-run scripts/inject-config-defaults.sh later to
# bake in their .env.local values for builds destined for a real watch.
if [ -f src/pkjs/config_defaults.js ]; then
  ok "src/pkjs/config_defaults.js already present"
else
  ./scripts/inject-config-defaults.sh --clear >/dev/null
  ok "wrote empty stub at src/pkjs/config_defaults.js"
fi

# ----------------------------------------------------------------------
step "smoke test: release build"
if pebble build >/tmp/dev-setup-build.log 2>&1; then
  ok "release build green ($(ls -la build/open-pebble-ai.pbw 2>/dev/null | awk '{print $5}') bytes)"
else
  warn "build failed; full log at /tmp/dev-setup-build.log"
  tail -20 /tmp/dev-setup-build.log
  fail "fix the build before continuing"
fi

# ----------------------------------------------------------------------
echo
echo "Setup complete. Next steps:"
echo
echo "  Emulator:           ./scripts/dev-watch.sh        # hot-reload loop"
echo "  Real hardware:      ./scripts/dev-hardware.sh -f  # install over BT via paired phone"
echo "  Local LLM stack:    ./scripts/dev-up.sh           # OWUI + Ollama via Docker (optional)"
echo
echo "If 'pebble' is not on your PATH after closing this shell, add to ~/.bashrc"
echo "or ~/.zshrc:  export PATH=\"\$HOME/.local/bin:\$PATH\""
