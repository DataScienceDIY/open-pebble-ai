# Open Pebble AI

Pebble Time 2 watch app that captures a voice query via the built-in dictation
API, sends it to an LLM endpoint, and displays the reply on the watch in chat
bubbles. Multi-turn within a session; tap SELECT from a response to ask a
follow-up.

Phase 1 ships with OpenWebUI as the backend. Phase 2 opens the same client to
any OpenAI-compatible endpoint (OpenAI, Groq, OpenRouter, vLLM, llama.cpp, LM
Studio, etc.).

## Setup

Requires Linux or macOS.

```bash
# 1. Install the Pebble SDK toolchain.
uv tool install pebble-tool --python 3.13
pebble sdk install latest

# 2. Create .env.local with your LLM endpoint (gitignored).
cat > .env.local <<'EOF'
OWUI_HOST=https://your-owui-host
OWUI_KEY=sk-your-api-key
OWUI_MODEL=your-model-id
EMU_PLATFORM=emery
EOF

# 3. Run the app in the emulator.
./scripts/dev.sh
```

`uv` is the Python tooling launcher — install it from <https://docs.astral.sh/uv/>
if you don't have it.

## Scripts

The `scripts/` folder holds exactly four:

| Script | Purpose |
|---|---|
| `dev.sh` | Run the app in the emery emulator. Bakes `.env.local` config into the build, builds with `OWUI_DEBUG=1`, installs, and rebuilds on source change. |
| `release.sh` | Build the publishable `.pbw`. Clears baked secrets, builds with real dictation, verifies no API key leaked. |
| `make-banner.py` | Regenerate the 720x320 appstore banner (`appstore/banner.png`). |
| `api-testbench.js` | Exercise an LLM endpoint and the response sanitizer across many iterations; writes a diagnostic report. |

### Development loop

`./scripts/dev.sh` builds with `OWUI_DEBUG=1`, which compiles a SELECT-in-IDLE
short-circuit (`src/c/dictation.c`) that fires a canned utterance instead of
opening the dictation modal — the emulator has no microphone. The script then
boots the emulator, installs the app, and rebuilds + reinstalls on every change
to `src/` or `package.json`. Ctrl-C stops it.

Tail logs in another terminal:

```bash
pebble logs --emulator emery
```

A debug build is emulator-only — never sideload it onto a real watch, the
utterance is hardcoded.

## Configuration

The watch app is configured from the Pebble companion app's settings page
(a Clay webview). It collects:

- **Server URL** — e.g. `https://owui.example.com`.
- **API key** — `sk-...`; leave blank for unauthenticated local servers.
- **Model** — the model ID to request, e.g. `llama3.2`.
- **Font size** — Medium or Large.
- **System prompt** — prepended invisibly to every conversation; defaults to a
  brevity instruction tuned for the small screen.

For development, `scripts/dev.sh` bakes the `.env.local` values straight into
the build (`src/pkjs/config_defaults.js`) so the emulator launches
pre-configured without touching the settings page.

## Watch controls

| Screen | Button | Action |
|---|---|---|
| IDLE | SELECT | start dictation |
| IDLE | BACK | exit app |
| SHOWING response | UP / DOWN | scroll (also drag on the touchscreen) |
| SHOWING response | SELECT | start a follow-up turn |
| SHOWING response | BACK | return to IDLE (keeps the conversation) |
| SENDING / WAITING | BACK | cancel and return to IDLE |

The conversation resets when the app is relaunched.

## Real hardware

Build a release `.pbw` and sideload it via the Pebble companion app:

```bash
./scripts/release.sh          # -> build/open-pebble-ai.pbw
```

Copy `build/open-pebble-ai.pbw` to the phone and open it in the Pebble Core
app to install onto a paired watch. The release build has real dictation and
no baked credentials — configure it from the settings page after install.

## Publishing

See [appstore/README.md](appstore/README.md) for the appstore submission
package and the `dev-portal.rebble.io` flow.

## Layout

```
src/c/         watch app (C, Pebble SDK)
src/pkjs/      phone-side JS proxy (XHR to the LLM, chunked AppMessage to watch)
scripts/       dev / release / asset tooling
appstore/      appstore submission package
```

## Caveat — Pebble Time 2 platform name

`package.json` targets `emery` (the historical Pebble 2 platform ID). The
2026 repebble PT2 may use a different identifier — if `pebble build` complains
about an unknown platform, swap it in `package.json` and `.env.local`'s
`EMU_PLATFORM`.

## License

MIT — see [LICENSE](LICENSE).

## Feedback

Bug reports, questions, feature requests: **datasciencediy.refutable156@passmail.net**
