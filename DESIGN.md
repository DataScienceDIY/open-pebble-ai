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

| State | Display | UP | SELECT | DOWN | BACK |
|---|---|---|---|---|---|
| `STATE_IDLE` | Large centered "Hold SELECT to speak" | — | start dictation | — | exit app |
| `STATE_DICTATING` | Pebble's built-in dictation modal | — | — | — | (handled by dictation API) |
| `STATE_SENDING` | Spinner + "Sending…" + "BACK to cancel" footer | — | — | — | cancel → IDLE |
| `STATE_WAITING` | Spinner + "Thinking…" + elapsed seconds + "BACK to cancel" footer | — | — | — | cancel → IDLE (orphan reply in JS) |
| `STATE_SHOWING` | Chat bubbles in a `ScrollLayer`: user utterance (blue border, right-aligned) on top, AI response (orange border, left-aligned) below | scroll up | start next turn (re-enter DICTATING) | scroll down | → IDLE (keeps conversation) |
| `STATE_ERROR` | Short message + "BACK to dismiss" | — | retry last turn | — | → IDLE |

In `STATE_SHOWING`, the `ScrollLayer` also scrolls by dragging on the touchscreen (a drag-distance-proportional offset applied on liftoff), in addition to the UP/DOWN buttons.

`update_ui_for_state()` is responsible for keeping the window stack linear: when transitioning into a state, it pops any windows that aren't owned by that state. This is important for the SHOWING→DICTATING→SENDING transition — without an explicit `ui_response_hide()`, the response window would remain on top of the spinner. Each `ui_*_show()` is idempotent; each `ui_*_hide()` is a no-op when the window isn't on the stack.

**New turn vs. new conversation.** SELECT from `SHOWING` is a follow-up turn; JS appends to the existing `messages` array. A fresh conversation is started by relaunching the app: `init()` sends `ResetConversation` to JS at launch, truncating `messages` back to just the system prompt. (An earlier design used a long-BACK gesture for in-session reset; `window_long_click_subscribe()` proved unreliable on the emery emulator and 2026 Core firmware, so reset is relaunch-only.)

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
- `FontSize` (int) — one-off config push: 0 = medium (GOTHIC_24), 1 = large (GOTHIC_28). Sent on `ready` and on every `webviewclosed` so a config change takes effect on the next render. Carried independently of chunk payloads.

**LLM output sanitization.** Before chunking, JS strips characters Pebble's system fonts can't render (smart quotes, em-dashes, ellipses, bullets, non-breaking spaces, zero-width joiners). Targeted replacements substitute ASCII equivalents where meaningful (em-dash → hyphen, curly quote → straight); anything still outside ASCII printable + LF + tab is dropped. See `sanitizeForPebble()` in `pkjs/chunker.js`.

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

The settings page is built with **@rebble/clay** — a Pebble package that renders an offline config webview from a JS schema with no external hosting. (The original plan embedded the page as a `data:text/html;base64,...` URL inside `index.js`; the 2026 Pebble Core companion app rejects `data:` URLs with `ERR_INVALID_URL`. Clay's offline page uses an internal URL scheme the app does accept, so Clay replaced the hand-rolled HTML.)

**Fields** (schema in `src/pkjs/clay_config.js`):
- **Server URL** — URL input, placeholder `https://owui.example.com`. Phase-1 expects the OWUI host root; the JS layer appends `/api/chat/completions` itself (see §8 for how phase 2 generalizes this).
- **API key** — password input; blank is allowed for unauthenticated local servers.
- **Model** — text input for the model ID.
- **Font size** — radio group, "Medium" (default, GOTHIC_24) / "Large" (GOTHIC_28). Pushed to the watch via the `FontSize` AppMessage key (see §3); takes effect on the next render.
- **System prompt** — multi-line textarea, pre-filled with the default `"Keep responses very brief, a couple sentences at most. The user is reading this on a tiny smartwatch screen."` Clay 1.0 ships no textarea component (only single-line `input`), so this is a custom component registered from `src/pkjs/clay_textarea.js`.

**Round-trip:** `index.js` runs Clay with `autoHandleEvents: false` and attaches its own `showConfiguration` / `webviewclosed` handlers. `showConfiguration` mirrors the current config into Clay's localStorage keys, then calls `Pebble.openURL(clay.generateUrl())`. On submit, `webviewclosed` reads values via `clay.getSettings()` and persists them to `localStorage` under key `owui_config`.

**Sync to watch:** the watch doesn't need URL/key/model/system-prompt — those are JS-only concerns. JS reads `localStorage` per request, so a mid-session settings change takes effect on the next turn automatically. Font size is the one watch-side setting and is pushed via the `FontSize` AppMessage key.

**Dev shortcut:** `scripts/dev.sh` bakes `.env.local` into `src/pkjs/config_defaults.js` (consumed by `config.js` as build-time defaults), so the emulator launches pre-configured without anyone opening the config page. `scripts/release.sh` clears that file so no baked endpoint or key ships in a published build.

---

## 6. Project layout

```
open-pebble-ai/
  package.json            # app metadata + the `pebble` block (no separate appinfo.json)
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
      index.js            # Pebble event wiring, Clay setup
      owui.js             # XHR to /api/chat/completions, builds messages with system prompt
      chunker.js          # UTF-8-safe splitter + ack-gated sender, response sanitizer
      config.js           # localStorage helpers, defaults
      config_defaults.js  # build-time baked defaults (gitignored; see §5)
      clay_config.js      # Clay form schema for the settings page
      clay_textarea.js    # custom Clay textarea component (system prompt field)
```

**`package.json` structure:**

```json
{
  "name": "open-pebble-ai",
  "author": "DataScienceDIY <datasciencediy.refutable156@passmail.net>",
  "version": "1.0.0",
  "keywords": ["pebble-app"],
  "private": true,
  "dependencies": { "@rebble/clay": "^1.0.8" },
  "pebble": {
    "displayName": "Open Pebble AI",
    "uuid": "1660488c-2553-4f43-a469-633b2b48f105",
    "sdkVersion": "3",
    "enableMultiJS": true,
    "targetPlatforms": ["emery"],
    "watchapp": { "watchface": false },
    "capabilities": ["configurable"],
    "messageKeys": [
      "UserMessage", "ResetConversation", "CancelInflight", "ChunkAck",
      "ResponseChunkIndex", "ResponseChunkTotal", "ResponseChunkText",
      "ErrorCode", "ConversationReset", "FontSize"
    ],
    "resources": {
      "media": [
        { "type": "bitmap", "name": "IMAGE_MENU_ICON",
          "file": "images/menu_icon.png", "menuIcon": true }
      ]
    }
  }
}
```

`capabilities: ["configurable"]` is what makes the Pebble app show the
settings gear; `@rebble/clay` renders that settings page (§5). `FontSize`
is the one message key driven by the config page — the rest are the
watch↔JS transport protocol (§3).

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

**(f) ScrollLayer click-config nesting crashes the emery emulator.** The textbook Pebble pattern is to call `scroll_layer_set_click_config_onto_window()` from inside your own `click_config_provider`. On the 2026 emery firmware/emulator that re-entrant click-setup faults at PC 0x3666d. The workaround used in `ui_response.c`: don't install a click_config_provider in `ui_response_init`; instead, in `window_load` (where `s_scroll_layer` is guaranteed non-NULL) call `scroll_layer_set_click_config_onto_window()` directly, then layer our SELECT/BACK provider on top via `window_set_click_config_provider()`. The order matters — calling our provider first and then having it invoke the scroll layer's setup is what triggers the crash. UP/DOWN scrolling and SELECT/BACK both work via this split.

**(g) Pebble fonts have a sparse Unicode coverage.** LLM output frequently contains characters (em-dash, curly quotes, ellipsis, NBSP) that render as empty boxes on the watch. `pkjs/chunker.js::sanitizeForPebble()` substitutes ASCII equivalents and strips the rest before chunking. The user's dictated text is ASCII (Pebble dictation API output) so no symmetric sanitization is needed on the watch side.

**(h) `window_long_click_subscribe()` is unreliable on the 2026 emery emulator and Core firmware.** `pebble emu-button` can't synthesize a real long-press — `-d N click` is a tap, and `push back; sleep; release back` doesn't fire the long-click handler either — and on Core hardware the handler proved flaky in practice. The app originally used long-BACK as a conversation-reset gesture; it was removed for this reason. Reset is now relaunch-only: `init()` sends `ResetConversation` at app launch (§1).

**(i) pypkjs's `removeEventListener` has a typo that breaks multi-turn.** In `pypkjs/javascript/events.py` the inner `del listener[i]` should read `del self.__listeners[event][i]` — instead it tries to delete an integer index on the JSFunction itself and throws a Python TypeError. The throw propagates back into JS, aborting whatever was calling `removeEventListener`. If that caller was a chunker `cleanup()` triggered from the last-chunk ack path, `onComplete()` never runs and the JS `inflight` flag stays true; every subsequent `UserMessage` then bounces with `ERR_BUSY` and the watch waits forever. Worked around in `pkjs/chunker.js`: set `done` and call `onComplete()` before the throw-prone `removeEventListener`, wrap that call in try/catch, and gate the listener with `done` so a stale subscription is inert. Patching the pypkjs typo upstream is the correct long-term fix.

**(j) `pkill -f 'qemu-pebble|pypkjs'` self-kills any shell whose command line contains those patterns.** The kill code must avoid putting the patterns in its own argv. `scripts/dev.sh`'s `reap()` uses the specific patterns `'qemu-pebble '` (trailing space) and `'python.*pypkjs'` — chosen so the script's own argv (`bash scripts/dev.sh`) and its config-baking `python3 -` heredoc can never match themselves.

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

Bring the stack up with `docker compose up -d`; the §5 curl command verifies it responds before the watch enters the picture. The local stack is optional — `scripts/dev.sh` reads whatever endpoint `.env.local` points at, which may equally be a remote OWUI or any OpenAI-compatible host.

### 9.2 Emulator layer (primary inner loop)

`pebble-tool` ships emulators for the historical platforms. Workflow:

```bash
pebble build
pebble install --emulator emery     # Pebble Time 2 platform
pebble logs --emulator emery        # live tail of APP_LOG output
```

**Critical:** the emulator's PebbleKit JS process runs in node, with full XHR support — so the phone-side logic runs end-to-end against the local OWUI container with **no real phone required**. This is the workflow that gets used 95% of the time.

**Dictation in the emulator.** The emulator does not have a microphone. Two mechanisms cover this:

1. **In-app fake-dictation short-circuit (primary).** Building with `OWUI_DEBUG=1 pebble build` defines the `OWUI_DEBUG_FAKE_DICTATION` macro. With it set, `dictation_start()` in `src/c/dictation.c` bypasses the dictation API entirely and feeds a canned utterance directly to the done-callback, cycling through a fixed set of utterances on successive presses. No external voice server, no microphone, no dependency on `pebble transcribe`. This is the path `scripts/dev.sh` uses. The canned text is fixed at compile time, so debug builds are emulator-only — never install one to a paired watch.
2. **`pebble transcribe` (fallback / dictation-callback coverage).** `pebble-tool` ships a persistent voice server: while it's up, every `dictation_session_start()` call returns the same canned text passed as the positional arg. Failure modes are simulated with `--error {connectivity,disabled,no-speech-detected}`. Run it by hand against a non-`OWUI_DEBUG` build to exercise the dictation-callback path itself — status enum handling, error transitions — which the in-app short-circuit deliberately skips.

**Dev script.** `scripts/dev.sh` is the inner loop: it bakes `.env.local` into `src/pkjs/config_defaults.js`, exports `OWUI_DEBUG=1`, builds, installs to the emulator, and rebuilds + reinstalls on every change to `src/` or `package.json` (via `fswatch`/`inotifywait`, with a polling fallback). This gives a sub-3-second loop from save to dictation-fired-in-emulator.

### 9.3 Real hardware layer (final-mile validation)

The emulator covers everything except: real microphone audio quality, real Bluetooth flakiness, real heap pressure under the actual firmware build, and the real config-page round-trip through the Pebble phone app.

**Requirements** (developer-supplied, not automatable):
- A Pebble Time 2 device.
- A phone with the Pebble companion app installed and the watch paired.
- The phone and the dev machine on the same LAN, OR the OWUI instance exposed publicly (e.g. tailscale).

**Getting a build onto the watch.** Build a release `.pbw` with `scripts/release.sh` (no baked secrets, real dictation), then either:

- copy `build/open-pebble-ai.pbw` to the phone and open it in the Pebble Core app to install onto the paired watch; or
- `pebble install --phone <phone-ip>` over Bluetooth (phone must have developer mode enabled), with `pebble logs --phone <phone-ip>` for the live tail.

For a LAN OWUI, the config page's "Server URL" field gets the dev machine's LAN IP (e.g. `http://192.168.1.50:3000`) rather than `localhost`. For OWUI over tailscale, use the tailnet hostname.

### 9.4 What gets tested where

| Test concern | Emulator | Hardware |
|---|---|---|
| State machine transitions | ✓ (debug build, manual emulator drive) | ✓ |
| Chunk reassembly / `ChunkAck` | ✓ | ✓ |
| OpenWebUI request shape | ✓ | ✓ |
| System prompt prepending | ✓ | ✓ |
| Multi-turn conversation | ✓ (debug build, rotating utterances) | ✓ |
| Error handling (network, 401, 5xx, timeout) | ✓ (point `.env.local` at a bad URL / wrong key / unreachable host) | partial |
| Response shape / sanitizer across models | ✓ (`scripts/api-testbench.js`) | n/a |
| Dictation status 5 (ConnectivityError) | `pebble transcribe --error connectivity` (release build) | turn off Bluetooth |
| Dictation callback paths (success/failure/abort) | ✓ (release build + `pebble transcribe`) | ✓ |
| Real heap pressure | ✗ | ✓ |
| Microphone quality / accent handling | ✗ | ✓ |
| Config webview round-trip through Pebble app | ✗ | ✓ |
| BT transport flakiness | ✗ | ✓ |

Two binaries cover the matrix: a debug build (`OWUI_DEBUG=1`, from `scripts/dev.sh`) for state-machine and integration coverage with deterministic input, and a release build (`scripts/release.sh`) with `pebble transcribe` for the dictation-callback paths that the short-circuit bypasses.

### 9.5 Repo layout for the dev environment

```
open-pebble-ai/
  docker-compose.yml      # optional local OWUI + Ollama, §9.1
  scripts/
    dev.sh                # bake .env.local → OWUI_DEBUG build → emulator → watch loop
    release.sh            # clear baked secrets → clean release build
    make-banner.py        # regenerate the 720x320 appstore banner
    api-testbench.js      # exercise an LLM endpoint + the response sanitizer
  .env.local              # OWUI_HOST, OWUI_KEY, OWUI_MODEL, EMU_PLATFORM (gitignored)
  README.md               # setup + the four scripts
```

The `scripts/` folder is deliberately capped at four entries: two operational
(`dev.sh`, `release.sh`) and two asset/diagnostic (`make-banner.py`,
`api-testbench.js`). `.env.local` is gitignored; so is the
`src/pkjs/config_defaults.js` that `dev.sh` bakes from it.

---

## Verification

Pre-implementation checks (cannot be done now in plan mode):

1. **Pebble SDK toolchain.** `uv tool install pebble-tool --python 3.13 && pebble sdk install latest`. Confirmed working.
2. **PT2 platform name.** Confirmed `emery` (see §6).
3. **OpenWebUI smoke test.** `docker compose up -d`, then a `curl` POST to `/api/chat/completions` (the §5 request shape) — confirms the stack from §9.1 works before any watch code exists.
4. **Emulator fake-dictation API.** Confirmed `pebble transcribe --emulator emery "<text>"` runs a persistent voice server. Failure simulation via `--error {connectivity,disabled,no-speech-detected}`.

End-to-end test plan (post-implementation):

1. **Config flow.** Install `.pbw`, open config from phone app (Clay page), enter Server URL, API key, model, save. Verify localStorage updated (JS log of `owui_config`).
2. **Happy path single-turn.** SELECT → speak "hello" → spinner → response visible and scrollable.
3. **Multi-turn.** Ask "remember the number 42" → ask "what number did I just say" → assert 42 in response (proves messages array growing on JS side).
4. **System prompt taking effect.** Set system prompt to "always respond in haiku" → ask anything → confirm haiku formatting.
5. **Conversation reset on relaunch.** After a multi-turn session, exit and relaunch the app → ask "what number did I just say" → should not remember 42 (proves `ResetConversation` at launch truncates the JS `messages` array).
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
- `/media/shared/open-pebble-ai/src/pkjs/index.js` — event wiring, `inflight` flag, Clay setup
- `/media/shared/open-pebble-ai/src/pkjs/owui.js` — XHR + system-prompt prepending; exports the single `endpoints(config)` helper that phase 2 will switch on
- `/media/shared/open-pebble-ai/src/pkjs/chunker.js` — UTF-8-safe split + ack-gated send, response sanitizer
- `/media/shared/open-pebble-ai/src/pkjs/clay_config.js` — Clay settings-page schema
- `/media/shared/open-pebble-ai/src/pkjs/clay_textarea.js` — custom Clay textarea component

Dev environment:
- `/media/shared/open-pebble-ai/docker-compose.yml` — optional local OWUI + Ollama stack
- `/media/shared/open-pebble-ai/scripts/dev.sh` — bake config, OWUI_DEBUG build, emulator hot-reload loop
- `/media/shared/open-pebble-ai/scripts/release.sh` — clean release build with baked secrets stripped
- `/media/shared/open-pebble-ai/.env.local` — OWUI_HOST, OWUI_KEY, OWUI_MODEL, EMU_PLATFORM
