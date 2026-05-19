#!/usr/bin/env bash
# Bring up the local OWUI + Ollama stack and verify with a smoke test.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.local ]; then
  cp .env.local.example .env.local
  echo "Created .env.local from template — edit as needed."
fi

docker compose up -d
echo "Waiting for OpenWebUI to come up on :3000..."
for i in {1..30}; do
  if curl -fs http://localhost:3000/health >/dev/null 2>&1 \
       || curl -fs http://localhost:3000/ >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# If the user hasn't pulled a model yet, prompt them.
if ! docker compose exec -T ollama ollama list 2>/dev/null | grep -q '.'; then
  echo
  echo "No Ollama models installed yet. Pulling llama3.2:1b (~1.3 GB)..."
  docker compose exec -T ollama ollama pull llama3.2:1b
fi

bash "$(dirname "$0")/smoke-curl.sh"
