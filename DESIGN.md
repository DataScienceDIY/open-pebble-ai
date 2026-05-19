# Open Pebble AI — Design Document

Pebble Time 2 watch app that sends dictated voice queries to an LLM endpoint.

## Context

The goal is a Pebble watch app for the revived repebble platform (Pebble Time 2, shipping 2026) that lets a user speak a query into the watch, sends the transcribed text to a self-hosted OpenWebUI server, and displays the LLM's response on the watch. The user-facing flow is "press SELECT, speak, read answer, press SELECT to ask a follow-up." The integration value is bringing a personal LLM to the wrist without writing per-provider client code — OpenWebUI already aggregates Ollama / OpenAI / Anthropic / etc. behind one OpenAI-compatible endpoint, so the watch app only needs to speak that one protocol.

**Phase 1** ships with OpenWebUI as the only supported backend. **Phase 2** opens the same code path to any OpenAI-compatible endpoint (OpenAI itself, Groq, Together, OpenRouter, vLLM, llama.cpp's server, local LM Studio, etc.) — a substantially larger potential user base for low marginal work, since OWUI is already speaking that protocol. The phase-1 design is structured so phase 2 is a small additive change rather than a refactor.

This document covers the architecture, message protocol, state model, and known risks. Implementation follows after approval.

---

## Confirmed scope

- **Hardware target:** Pebble Time 2 only (`targetPlatforms: ["emery"]` — see §6 caveat).
- **Conversation model:** Multi-turn within one app session. The PebbleKit JS layer owns the growing `messages` array. Closing the app clears it. No persistence across launches.
- **Response display:** Non-streaming. JS sends `stream: false`, waits for the full response, then chunks it back to the watch. Watch shows "Thinking…" with an elapsed-second counter during the wait.
- **Model selection:** Fixed in the phone-side configuration page. Server URL, API key, model ID, and system prompt all live in PebbleKit JS `localStorage`.
- **System prompt:** Configurable in the same page, with a sensible default (`"Keep responses very brief, a couple sentences at most. The user is reading this on a tiny smartwatch screen."`). Sent as `messages[0]` with `role: "system"` on every request — invisible to the watch user, never displayed.

---

## 1. Watch app state machine

Single `AppState` enum in C; every transition routes through one `update_ui_for_state()` dispatcher.

| State | Display | UP | SELECT | DOWN | BACK | Long-BACK |
|---|---|---|---|---|---|---|
| `STATE_IDLE` | "Hold SELECT to speak" + turn counter | — | start dictation | — | exit app | reset conversation |
| `STATE_DICTATING` | Pebble's built-in dictation modal | — | — | — | (handled by dictation API) | — |
| `STATE_SENDING` | Spinner + "Sending…" | — | — | — | cancel → IDLE | — |
| `STATE_WAITING` | Spinner + "Thinking…" + elapsed seconds | — | — | — | cancel → IDLE (orphan reply in JS) | — |
| `STATE_SHOWING` | `ScrollLayer` with response text | scroll up | start next turn (re-enter DICTATING) | scroll down | → IDLE (keeps conversation) | reset conversation |
| `STATE_ERROR` | Short message + "BACK to dismiss" | — | retry last turn | — | → IDLE | — |

**New turn vs. new conversation.** SELECT from `SHOWING` is a follow-up turn; JS appends to the existing `messages` array. Long-pressing BACK (700ms) sends `ResetConversation` to JS, which truncates `messages` back to just the system prompt and resets the watch's turn counter. IDLE footer reads "Long BACK = new chat".

**Note:** the dictation modal owns the screen during `STATE_DICTATING`; we cannot intercept buttons. Transition out is driven entirely by the dictation callback.

---

## 2. Multi-turn state — JS owns the conversation

The PebbleKit JS layer holds the `messages` array; the watch sends only the new utterance per turn.

Rationale:
- JS runtime persists for the lifetime of the foregrounded watchapp, which matches our session-only scope.
- Watch heap is ~24–32 KB. A 10-turn conversation at 1 KB/turn would consume a third of available heap purely to duplicate state the phone already has.
- Re-shipping the full conversation watch→JS every turn would push past the 8 KB outbox limit by turn 5–8 and force chunked *uploads* — a complexity we don't need.

**Layout in JS:**

```js
let conversation = [
  { role: "system", content: <config.systemPrompt> }
];
let inflight = false;
```

`ResetConversation` truncates back to `conversation = [conversation[0]]` (preserves system prompt). `webviewclosed` with a changed system prompt rebuilds index 0 in place.

**JS-killed-mid-session edge case** (rare but possible if phone OS reclaims the companion app): in the `ready` handler, if a `UserMessage` arrives without a built `conversation`, initialize from `localStorage` config and notify the watch via `ConversationReset` so the turn counter resyncs.

The watch holds only: current transcription buffer (1024 bytes), current response assembly buffer, turn counter (int), state enum.

---

## 3. Chunked transport protocol

**Message keys** (declared in `package.json` `messageKeys`):

Watch → JS:
- `UserMessage` (string) — the new utterance
- `ResetConversation` (int) — clear messages array back to system prompt
- `CancelInflight` (int) — abort current XHR
- `ChunkAck` (int) — application-level ack of received chunk index

JS → Watch:
- `ResponseChunkIndex` (int) — 0-based
- `ResponseChunkTotal` (int) — total chunk count
- `ResponseChunkText` (string) — payload
- `ErrorCode` (int) — enum (see §4)
- `ConversationReset` (int) — JS-initiated resync

**Watch→JS upload.** Single AppMessage. Dictation transcriptions are bounded by our 1024-byte capture buffer (well under the 8 KB outbox).

**JS→Watch download chunking:**
- Chunk size: **2 KB of UTF-8 text per message** (leaves ~6 KB headroom under the 8 KB inbox for dict/key overhead).
- Strategy: **explicit index + total** in every chunk, not a sentinel. With index/total the watch can detect missing chunks and surface "Response incomplete" rather than displaying truncated text as if complete.
- JS chunking must split on **UTF-8 codepoint boundaries**, not byte boundaries — a split codepoint will render as garbage on the e-paper. Step backward until the high-bit pattern indicates a codepoint start.
- Send chunks **sequentially with application-level backpressure**: only send chunk N+1 after the watch sends `ChunkAck` for chunk N. The transport-level AppMessage ack only confirms `inbox_received` fired — not that the watch successfully copied the bytes (e.g. heap-low could lose the chunk). Adds ~100ms per chunk but is the only way to guarantee end-to-end delivery.
- Cap responses at `MAX_CHUNKS = 16` (32 KB total). Larger responses fail fast with `ErrorCode = RESPONSE_TOO_LARGE` before any transport.

**Watch reassembly:** allocate `response_buffer = malloc(total * CHUNK_SIZE)` on receipt of chunk 0 (after sanity-checking `total <= MAX_CHUNKS`). Track a `chunks_received` bitmap. Transition to `STATE_SHOWING` only when all chunks received. 15s timeout between chunks → free buffer + `STATE_ERROR`.

**Failure handling.** On `outbox_failed` in JS, retry the same chunk up to 3 times with exponential backoff (250ms, 500ms, 1s). After 3 failures, send `ErrorCode = TRANSPORT_FAILED` and abandon.

---

## 4. Error surfaces

All errors land in `STATE_ERROR` with a single-line message. `ErrorCode` is an enum; the watch picks the localizable string locally rather than relying on JS to format it.

| Cause | Detected where | Watch text |
|---|---|---|
| Dictation status 5 (ConnectivityError) | C callback | "Phone not connected" |
| Dictation status 2 (NoSpeechDetected) | C callback | "Didn't hear anything" |
| Dictation status 1 (UserRejected) | C callback | silent return to IDLE |
| Dictation status 8 (RecognitionFailure) | C callback | "Could not transcribe" |
| XHR `onerror` / network | JS | "Server unreachable" |
| HTTP 401 | JS | "Bad API key — open settings" |
| HTTP 403 | JS | "Access denied" |
| HTTP 5xx | JS | "Server error" |
| XHR timeout (`xhr.timeout = 90000`) | JS | "Timed out — try again" |
| Response too large | JS pre-send | "Response too long" |
| Heap alloc failure on watch | C | "Out of memory" |
| Transport chunk failure after retries | JS | "Lost connection" |

---

## 5. Configuration page

**Fields (HTML form):**
- **Server URL** — text, placeholder `https://owui.example.com`. Phase-1 expects the OWUI host root; the JS layer appends `/api/chat/completions` and `/api/models` itself (see §8 for how phase 2 generalizes this).
- **API key** — password input
- **Model ID** — text input by default; a "Load models" button calls `GET {url}/api/models` and replaces it with a `<select>` populated from response `id` fields
- **System prompt** — multi-line textarea, pre-filled with the default `"Keep responses very brief, a couple sentences at most. The user is reading this on a tiny smartwatch screen."` A small "Reset to default" link clears any override.
- **Test connection** — button that sends a one-shot `messages: [{"role":"user","content":"ping"}]` request and shows the HTTP status inline.

**Round-trip:** opened via `Pebble.openURL(configUrl + '?current=' + encodeURIComponent(JSON.stringify(current)))`. On submit, the page redirects to `pebblejs://close#` with the JSON-encoded settings. JS receives in `webviewclosed`, persists to `localStorage` under key `owui_config`.

**Sync to watch:** the watch doesn't need URL/key/model/system-prompt — those are JS-only concerns. JS reads `localStorage` per request, so a mid-session settings change takes effect on the next turn automatically.

**Hosting:** for v1, embed the config HTML as a `data:text/html;base64,...` URL inside `index.js`. Avoids the need for any external hosting (GitHub Pages, custom domain, etc.) for the initial release. The page is small enough (~3 KB) that base64-encoding it stays well under any reasonable URL limit.

---

## 6. Project layout

```
open-pebble-ai/
  package.json
  appinfo.json            # may be merged into package.json depending on pebble-tool version
  README.md
  src/
    c/
      main.c              # entry, app_message_open, window stack
      state.h state.c     # AppState enum + transitions
      ui_idle.c/.h        # IDLE + ERROR windows
      ui_response.c/.h    # SHOWING window with ScrollLayer
      ui_spinner.c/.h     # SENDING / WAITING window
      dictation.c/.h      # wraps dictation_session_*
      transport.c/.h      # AppMessage send/recv + chunk reassembly
      message_keys.h      # ErrorCode enum, CHUNK_SIZE, MAX_CHUNKS constants
    pkjs/
      index.js            # Pebble event wiring
      owui.js             # XHR to /api/chat/completions, builds messages with system prompt
      chunker.js          # UTF-8-safe splitter + ack-gated sender
      config.js           # localStorage helpers, defaults
      config_html.js      # exports the data: URL for the config page
```

**`package.json` skeleton:**

```json
{
  "name": "open-pebble-ai",
  "version": "0.1.0",
  "keywords": ["pebble-app"],
  "dependencies": {},
  "pebble": {
    "displayName": "Open Pebble AI",
    "uuid": "GENERATE-WITH-uuidgen",
    "sdkVersion": "3",
    "enableMultiJS": true,
    "targetPlatforms": ["emery"],
    "watchapp": { "watchface": false },
    "messageKeys": [
      "UserMessage", "ResetConversation", "CancelInflight", "ChunkAck",
      "ResponseChunkIndex", "ResponseChunkTotal", "ResponseChunkText",
      "ErrorCode", "ConversationReset"
    ],
    "resources": { "media": [] }
  }
}
```

**Platform name confirmed: `emery`.** Per the coredevices/mobileapp `WatchType` enum, `emery` = Pebble Time 2 (rectangular, color). The other new platforms in current pebble-tool are `flint` (Pebble 2 Duo, monochrome) and `gabbro` (Pebble Round 2, color round) — not our target. Source: [coredevices/mobileapp `LockerUtil.kt`](https://github.com/coredevices/mobileapp/blob/main/pebble/src/commonMain/kotlin/coredevices/pebble/ui/LockerUtil.kt).

---

## 7. Phase 2 — Generic OpenAI-compatible endpoint support

The OWUI wire protocol is already OpenAI-compatible; only the URL paths and a couple of behavioral quirks differ across providers.

**What changes in phase 2:**

1. **Config page adds a "Provider" dropdown** with three presets:
   - *OpenWebUI* — paths `/api/chat/completions`, `/api/models` (current default)
   - *OpenAI-compatible* — paths `/v1/chat/completions`, `/v1/models` (covers OpenAI, Groq, Together, OpenRouter, vLLM, llama.cpp server, LM Studio, Ollama's OpenAI shim)
   - *Custom* — exposes the two paths as overridable text fields for one-off setups
2. **Config schema gains** `providerType: "owui" | "openai" | "custom"` and (when custom) `chatPath` / `modelsPath`.
3. **No watch-side changes.** The protocol between watch and JS is provider-agnostic by construction (the watch only sees utterances and response chunks). Phase 2 is entirely a JS + config-page change.

**Phase-1 design hook that makes this cheap:** all endpoint URL construction lives in a single helper in `owui.js`:

```js
function endpoints(config) {
  const base = config.serverUrl.replace(/\/$/, '');
  // Phase 1: hard-coded OWUI paths
  return {
    chat:   `${base}/api/chat/completions`,
    models: `${base}/api/models`,
  };
}
```

In phase 2 this becomes a switch on `config.providerType`. Everywhere else in the codebase (request building, model picker, "Test connection") calls `endpoints(config)` — so the diff is small and localized. The XHR body, auth header, and response parsing are already OpenAI-shape and need no change.

**Known per-provider quirks to document, not solve, in phase 2:**
- OpenAI requires the `model` to be one of their published IDs; some proxies (OpenRouter) accept slash-namespaced IDs like `anthropic/claude-3-haiku`.
- Some providers reject `stream: false` for certain models; we'd need a per-provider note or detection.
- Local servers (llama.cpp, LM Studio) often skip auth — config should accept empty API key and not send the header when blank.
- Rename file `owui.js` → `chat_api.js` in phase 2; phase 1 keeps `owui.js` since that's all it speaks.

This phase-2 work is explicitly **out of scope for the initial release** but is called out here so the v1 implementation doesn't paint us into a corner.

---

## 8. Non-obvious risks

**(a) Dictation buffer sizing vs. heap.** `dictation_session_create(buffer_size, ...)` allocates upfront and holds it for the session lifetime. Recommend `dictation_session_create(1024, ...)` and **destroy + recreate the session per turn** rather than holding one across the session. Frees heap during `STATE_WAITING` exactly when the response buffer needs it most.

**(b) Race: user re-dictates while a previous response is in flight.** The state machine prevents this at the UI level by only allowing SELECT-to-dictate from IDLE or SHOWING. As belt-and-suspenders, JS sets `inflight = true` for the duration of an XHR + chunk send, and refuses inbound `UserMessage` while inflight (returns `ErrorCode = BUSY`).

**(c) `transcription` string lifetime.** The `char *transcription` argument to the dictation callback is freed *immediately* after the callback returns. Multiple ports of this kind of app have shipped bugs from holding the pointer for later use. Centralize this in `dictation.c` with one `static char captured_utterance[1024]` so the rule lives in one place — every caller of dictation gets a copy by construction.

**(d) AppMessage ack vs. delivery.** `ack` means `inbox_received` fired, not that the application processed the chunk. If the watch is heap-starved when chunk 3 arrives, the receive will ack but the chunk is effectively lost. We mitigate with the `ChunkAck` application-level reply (§3).

**(e) System prompt counted toward context.** A long custom system prompt eats context window the same as conversation turns. For self-hosted Ollama with 2k–8k context windows this can bite. Document in the config page: "Long system prompts reduce how much conversation the model can remember."

---

## 9. Sidecar development environment

A self-contained dev loop is mandatory — the app spans three runtimes (watch C, phone JS, server) and debugging it remotely is intractable. The dev environment has three layers, designed so each can be exercised independently.

### 9.1 Local OpenWebUI + tiny model stack

A `docker-compose.yml` at the repo root brings up the backend the watch app will hit:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    volumes: [ollama_data:/root/.ollama]
    ports: ["11434:11434"]
    # one-time: `docker compose exec ollama ollama pull llama3.2:1b` (~1.3 GB, runs on CPU)
  openwebui:
    image: ghcr.io/open-webui/open-webui:main
    ports: ["3000:8080"]
    environment:
      - OLLAMA_BASE_URL=http://ollama:11434
      - WEBUI_AUTH=false  # dev only — disables login so API keys aren't needed
    depends_on: [ollama]
volumes: { ollama_data: {} }
```

The `WEBUI_AUTH=false` setting bypasses the login wall in dev — fine because it's bound to localhost. For real-hardware tests against a real key, set `WEBUI_AUTH=true` and follow the production config-page flow.

A `scripts/dev-up.sh` brings the stack up and runs the curl smoke-test from §5 against it to verify before the watch even enters the picture.

### 9.2 Emulator layer (primary inner loop)

`pebble-tool` ships emulators for the historical platforms. Workflow:

```bash
pebble build
pebble install --emulator emery     # Pebble Time 2 platform
pebble logs --emulator emery        # live tail of APP_LOG output
```

**Critical:** the emulator's PebbleKit JS process runs in node, with full XHR support — so the phone-side logic runs end-to-end against the local OWUI container with **no real phone required**. This is the workflow that gets used 95% of the time.

**Dictation in the emulator.** The emulator does not have a microphone. `pebble-tool` exposes `pebble transcribe`, which runs a persistent voice server: while it's up, every `dictation_session_start()` call from the watch app returns the same canned text passed as the positional arg. Failure modes are simulated with `--error {connectivity,disabled,no-speech-detected}`.

**Hot-reload script.** `scripts/dev-watch.sh` runs `pebble transcribe` in the background and rebuilds + reinstalls on source change:

```bash
pebble transcribe --emulator emery "what is the capital of france" &
fswatch -o src/ package.json | while read; do
  pebble build && pebble install --emulator emery
done
```

This gives a sub-3-second loop from save to dictation-fired-in-emulator.

### 9.3 Real hardware layer (final-mile validation)

The emulator covers everything except: real microphone audio quality, real Bluetooth flakiness, real heap pressure under the actual firmware build, and the real config-page round-trip through the Pebble phone app.

**Requirements** (developer-supplied, not automatable):
- A Pebble Time 2 device.
- A phone with the Pebble companion app installed and the watch paired.
- The phone and the dev machine on the same LAN, OR the OWUI instance exposed publicly (e.g. tailscale).

**Install over Bluetooth from the dev machine:**

```bash
pebble install --phone <phone-ip>   # phone must have developer mode enabled in Pebble app
pebble logs --phone <phone-ip>
```

For a LAN OWUI, the config page's "Server URL" field gets the dev machine's LAN IP (e.g. `http://192.168.1.50:3000`) rather than `localhost`. For OWUI over tailscale, use the tailnet hostname.

**A `scripts/dev-hardware.sh`** wraps this with the IP cached in `.env.local`.

### 9.4 What gets tested where

| Test concern | Emulator | Hardware |
|---|---|---|
| State machine transitions | ✓ | ✓ |
| Chunk reassembly / `ChunkAck` | ✓ | ✓ |
| OpenWebUI request shape | ✓ | ✓ |
| System prompt prepending | ✓ | ✓ |
| Multi-turn conversation | ✓ | ✓ |
| Error handling (network, 401, 5xx, timeout) | ✓ (mock with a `scripts/fake-owui.py` flask shim that returns chosen status) | partial |
| Dictation status 5 (ConnectivityError) | turn off emulator phone-sim | turn off Bluetooth |
| Real heap pressure | ✗ | ✓ |
| Microphone quality / accent handling | ✗ | ✓ |
| Config webview round-trip through Pebble app | ✗ | ✓ |
| BT transport flakiness | ✗ | ✓ |

### 9.5 Repo additions for the dev environment

```
open-pebble-ai/
  docker-compose.yml            # OWUI + Ollama, §9.1
  scripts/
    dev-up.sh                   # bring up OWUI + smoke-test
    dev-down.sh
    dev-watch.sh                # fswatch → build → install --emulator
    dev-hardware.sh             # install --phone using .env.local
    fake-owui.py                # tiny flask shim to inject 401/5xx/timeout
    smoke-curl.sh               # the §5 curl command, parameterized
  .env.local.example            # OWUI_HOST, OWUI_KEY, PHONE_IP
  README.md                     # "Day 1" section: docker compose up → pebble install --emulator → speak
```

The `.env.local.example` is committed; `.env.local` is gitignored. README's Day-1 section gets the developer from clone to a working "ask the watch a question" loop in under 15 minutes on a clean machine, gated only by SDK install and the one-time `ollama pull`.

---

## Verification

Pre-implementation checks (cannot be done now in plan mode):

1. **Pebble SDK toolchain.** `uv tool install pebble-tool --python 3.13 && pebble sdk install latest`. Confirmed working.
2. **PT2 platform name.** Confirmed `emery` (see §6).
3. **OpenWebUI smoke test.** `docker compose up -d && scripts/smoke-curl.sh` — confirms the stack from §9.1 works before any watch code exists.
4. **Emulator fake-dictation API.** Confirmed `pebble transcribe --emulator emery "<text>"` runs a persistent voice server. Failure simulation via `--error {connectivity,disabled,no-speech-detected}`.

End-to-end test plan (post-implementation):

1. **Config flow.** Install `.pbw`, open config from phone app, enter URL+key, click "Load models", select a model, save. Verify localStorage updated (`Pebble.getActiveWatchInfo()` or JS log).
2. **Happy path single-turn.** SELECT → speak "hello" → confirm → spinner → response visible and scrollable.
3. **Multi-turn.** Ask "remember the number 42" → ask "what number did I just say" → assert 42 in response (proves messages array growing on JS side).
4. **System prompt taking effect.** Set system prompt to "always respond in haiku" → ask anything → confirm haiku formatting.
5. **Long-BACK reset.** Long-press BACK from SHOWING → IDLE turn counter resets to 1 → next "what number did I just say" should not remember 42.
6. **Error paths.** Test each row of §4 (turn off Bluetooth for status 5, set bad key for 401, point at a down server for `onerror`, set 10-byte response cap to test `RESPONSE_TOO_LARGE`).
7. **Long response.** Prompt requesting ~5 KB of output → confirm chunked reassembly and scrolling.

---

## Critical files for implementation

App code:
- `/media/shared/open-pebble-ai/package.json` — message keys, target platforms, UUID
- `/media/shared/open-pebble-ai/src/c/main.c` — entry, `app_message_open(8192, 8192)`, window stack
- `/media/shared/open-pebble-ai/src/c/state.c` — state machine dispatch
- `/media/shared/open-pebble-ai/src/c/transport.c` — chunk reassembly + `ChunkAck`
- `/media/shared/open-pebble-ai/src/c/dictation.c` — owns `captured_utterance` buffer
- `/media/shared/open-pebble-ai/src/pkjs/index.js` — event wiring, `inflight` flag
- `/media/shared/open-pebble-ai/src/pkjs/owui.js` — XHR + system-prompt prepending; exports the single `endpoints(config)` helper that phase 2 will switch on
- `/media/shared/open-pebble-ai/src/pkjs/chunker.js` — UTF-8-safe split + ack-gated send
- `/media/shared/open-pebble-ai/src/pkjs/config_html.js` — embedded data: URL config page

Dev environment:
- `/media/shared/open-pebble-ai/docker-compose.yml` — OWUI + Ollama stack
- `/media/shared/open-pebble-ai/scripts/dev-watch.sh` — emulator hot-reload loop
- `/media/shared/open-pebble-ai/scripts/dev-hardware.sh` — install over BT to paired device
- `/media/shared/open-pebble-ai/scripts/fake-owui.py` — flask shim for error-path tests
- `/media/shared/open-pebble-ai/.env.local.example` — OWUI_HOST, OWUI_KEY, PHONE_IP
