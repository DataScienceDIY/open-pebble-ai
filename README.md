# Open Pebble AI

Pebble Time 2 watch app that captures a voice query via the built-in dictation
API, sends it to an LLM endpoint, and displays the reply on the watch.

**Phase 1** ships with OpenWebUI as the backend. **Phase 2** opens the same
client to any OpenAI-compatible endpoint (OpenAI, Groq, Together, OpenRouter,
vLLM, llama.cpp, LM Studio, etc.) — see [DESIGN.md §7](DESIGN.md).

Design: see [DESIGN.md](DESIGN.md).

## Day 1 — clone to working query in ~15 minutes

Requires Linux/macOS, `docker`, `uv` (or another way to run Python 3.13).

```bash
# 1. Install the Pebble SDK.
uv tool install pebble-tool --python 3.13
pebble sdk install latest

# 2. Bring up the local OpenWebUI + Ollama stack.
#    First run pulls the llama3.2:1b model (~1.3 GB).
./scripts/dev-up.sh

# 3. Build + install to the emulator, with hot reload on source change.
#    First arg is the fake transcription used for SELECT in the emulator.
./scripts/dev-watch.sh "what is the capital of france"
```

In a separate terminal, tail logs:

```bash
pebble logs --emulator emery
```

Then in the emulator: press **SELECT** → dictation modal fakes the canned
transcription → spinner → response renders.

## Configuration

The first time the app runs (real hardware), open it from the Pebble companion
app and tap **Settings**. The config page asks for:

- **Server URL** (e.g. `http://192.168.1.50:3000` for a LAN OWUI)
- **API key** (`sk-...` from OWUI → Settings → Account → API keys). Blank is
  fine when `WEBUI_AUTH=false` in dev.
- **Model** (`llama3.2:1b`, etc). Hit **Load models** to populate from the
  server — needs OWUI's `CORS_ALLOW_ORIGIN=*` (set in our dev compose file).
- **System prompt** — prepended invisibly to every conversation. Defaults to
  "Keep responses very brief, a couple sentences at most."

In the emulator, the config page is reachable via
`pebble emu-app-config --emulator emery`.

## Watch controls

| Screen | Button | Action |
|---|---|---|
| IDLE | SELECT | start dictation |
| IDLE | BACK (long) | reset conversation |
| IDLE | BACK | exit app |
| SHOWING response | UP / DOWN | scroll |
| SHOWING response | SELECT | start follow-up turn |
| SHOWING response | BACK | return to IDLE (keeps conversation) |
| SHOWING response | BACK (long) | reset conversation |
| SENDING / WAITING | BACK | cancel and return to IDLE |
| ERROR | SELECT | retry last turn (TODO) |
| ERROR | BACK | dismiss |

## Real hardware

```bash
echo 'PHONE_IP=192.168.1.42' >> .env.local   # from Pebble app → Developer
./scripts/dev-hardware.sh --follow
```

The phone needs the Pebble companion app installed with **Developer Connection**
enabled. The phone and the OWUI server must be able to reach each other; if OWUI
runs on your dev machine, use that machine's LAN IP (not `localhost`) in the
Server URL.

## Error-path testing

`scripts/fake-owui.py` is a flask shim that returns chosen failure modes:

```bash
pip install flask
python scripts/fake-owui.py 401      # bad API key
python scripts/fake-owui.py 500      # server error
python scripts/fake-owui.py timeout  # hangs forever → XHR timeout
python scripts/fake-owui.py huge     # 50KB response → RESPONSE_TOO_LARGE
```

Point Server URL at `http://<dev-machine>:3001` to exercise.

## Layout

```
src/c/         watch app (C, Pebble SDK)
src/pkjs/      phone-side JS proxy (XHR to OWUI, chunked AppMessage to watch)
scripts/       dev environment helpers
docker-compose.yml   OWUI + Ollama stack
DESIGN.md      architecture reference
```

## Caveat — Pebble Time 2 platform name

`package.json` targets `emery` (the historical Pebble 2 platform ID). The
2026 repebble PT2 may have a different identifier — if `pebble build` complains
about an unknown platform, swap it in `package.json` and `.env.local`'s
`EMU_PLATFORM`. See DESIGN.md §6.
