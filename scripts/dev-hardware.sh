#!/usr/bin/env bash
# Install the current build to a real Pebble paired to the phone at $PHONE_IP.
# Phone must have the Pebble companion app installed with developer mode on.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] && set -a && . ./.env.local && set +a

if [ -z "${PHONE_IP:-}" ]; then
  echo "PHONE_IP not set in .env.local. Find it in Pebble app → Developer → Developer Connection."
  exit 1
fi

pebble build
pebble install --phone "$PHONE_IP"

case "${1:-}" in
  -f|--follow) pebble logs --phone "$PHONE_IP" ;;
esac
