#!/usr/bin/env bash
# Verifies the OWUI stack responds to a chat completion. Used by dev-up.sh and
# as a standalone "is the backend healthy?" check.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] && set -a && . ./.env.local && set +a

: "${OWUI_HOST:=http://localhost:3000}"
: "${OWUI_MODEL:=llama3.2:1b}"

AUTH=()
if [ -n "${OWUI_KEY:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${OWUI_KEY}")
fi

echo "Smoke-testing ${OWUI_HOST} with model ${OWUI_MODEL}..."
# chat_id is required: OWUI's /api/chat/completions errors with 400
# ("'NoneType' object has no attribute 'startswith'") when chat_id is missing.
RESP=$(curl -fsS -X POST "${OWUI_HOST}/api/chat/completions" \
  -H "Content-Type: application/json" \
  "${AUTH[@]}" \
  -d "{\"model\":\"${OWUI_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"say hi in 3 words\"}],\"stream\":false,\"chat_id\":\"smoke-test\",\"id\":\"smoke-test\"}")

echo "$RESP" | head -c 400
echo
echo "Smoke test OK."
