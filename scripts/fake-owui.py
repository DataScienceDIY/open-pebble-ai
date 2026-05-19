#!/usr/bin/env python3
"""Tiny flask shim that returns chosen HTTP statuses on /api/chat/completions
so the watch can exercise its error paths without needing OWUI to misbehave.

Usage:
    pip install flask
    python scripts/fake-owui.py 401      # always returns 401
    python scripts/fake-owui.py 500
    python scripts/fake-owui.py timeout  # hangs forever — exercises XHR timeout
    python scripts/fake-owui.py huge     # returns a 50KB response (RESPONSE_TOO_LARGE)

Then point Server URL in the watch config at http://<dev-machine-ip>:3001
"""
import sys
import time

from flask import Flask, jsonify

MODE = sys.argv[1] if len(sys.argv) > 1 else "ok"
app = Flask(__name__)


@app.route("/api/models", methods=["GET"])
def models():
    return jsonify({"data": [{"id": "fake-model-a"}, {"id": "fake-model-b"}]})


@app.route("/api/chat/completions", methods=["POST"])
def chat():
    if MODE == "timeout":
        time.sleep(600)
        return ""
    if MODE == "huge":
        return jsonify({"choices": [{"message": {"role": "assistant",
                                                 "content": "x" * 50_000}}]})
    if MODE.isdigit():
        return ("simulated", int(MODE))
    return jsonify({"choices": [{"message": {"role": "assistant",
                                             "content": "hello from fake-owui"}}]})


if __name__ == "__main__":
    print(f"fake-owui mode={MODE} listening on :3001", flush=True)
    app.run(host="0.0.0.0", port=3001)
