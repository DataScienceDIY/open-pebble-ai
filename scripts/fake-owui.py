#!/usr/bin/env python3
"""Tiny stdlib HTTP server that mimics OWUI's /api/chat/completions and
/api/models, so the watch can exercise its state machine + chunked transport
without depending on an upstream LLM's latency.

Usage:
    python scripts/fake-owui.py              # default: return "hello from fake-owui"
    python scripts/fake-owui.py 401          # always return HTTP 401
    python scripts/fake-owui.py 500
    python scripts/fake-owui.py timeout      # hang forever (XHR timeout test)
    python scripts/fake-owui.py huge         # 50KB response (RESPONSE_TOO_LARGE)
    REPLY="custom text" python scripts/fake-owui.py  # custom canned reply

Point the watch config's Server URL at http://localhost:3001 (or the dev
machine's LAN IP from a real phone).

stdlib-only — no flask/pip required.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = sys.argv[1] if len(sys.argv) > 1 else "ok"
PORT = int(os.environ.get("FAKE_OWUI_PORT", "3001"))
REPLY = os.environ.get("REPLY", "hello from fake-owui")


def chat_payload(text: str) -> bytes:
    return json.dumps({
        "choices": [{"message": {"role": "assistant", "content": text}}]
    }).encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # verbose by default for harness debugging
        super().log_message(fmt, *args)

    def _send(self, status: int, body: bytes, ctype: str = "application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/models":
            self._send(200, json.dumps({"data": [
                {"id": "fake-model-a"}, {"id": "fake-model-b"},
            ]}).encode())
            return
        self._send(404, b'{"detail":"not found"}')

    def do_POST(self):
        if self.path != "/api/chat/completions":
            self._send(404, b'{"detail":"not found"}')
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)  # noqa: F841 (drained for politeness)

        if MODE == "timeout":
            time.sleep(600)
            return
        if MODE == "huge":
            self._send(200, chat_payload("x" * 50_000))
            return
        if MODE.isdigit():
            self._send(int(MODE), b'{"detail":"simulated"}')
            return
        self._send(200, chat_payload(REPLY))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"fake-owui mode={MODE} listening on :{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
