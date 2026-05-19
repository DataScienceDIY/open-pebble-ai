// UTF-8-safe text chunker + ack-gated AppMessage sender.
// Must stay in sync with C-side CHUNK_SIZE / MAX_CHUNKS in src/c/message_keys.h.

var CHUNK_SIZE = 2048;
var MAX_CHUNKS = 16;

// --- Sanitization pipeline ---------------------------------------------
// LLM-emitted text is messy in predictable ways. The full pipeline runs
// every reply through, in order:
//   1. stripHarmonyTokens   — gpt-oss / o1 channel markers
//   2. unwrapJsonContent    — inner JSON some models emit as their reply
//   3. stripMarkdown        — ** _ # > ` and list bullets
//   4. (existing) Unicode replacements + ASCII-printable strip + trim
//
// Each stage is a no-op when its trigger isn't present, so clean models
// (Gemma in our testbench data) pass through with only the Unicode pass
// touching them.
//
// FUTURE: if this pipeline grows enough stages that "what to apply" becomes
// per-model knowledge — e.g. one model needs JSON unwrap but trips on
// stripMarkdown, another emits a wrapper format we don't recognize yet —
// add a model-recognition step that maps the configured model ID to a
// sanitizer profile (set of stages + their parameters), and run only the
// stages that profile selects. The config page already collects the model
// ID; the watch->JS plumbing for FontSize shows the pattern for a similar
// per-config dispatch on the watch side. Today the every-model pipeline
// is cheap enough that the generic approach wins on simplicity.

// gpt-oss / o1-style reasoning models structure their output with
// `<|channel|>analysis<|message|>...` and `<|channel|>final<|message|>...`
// markers. Servers usually unwrap them but some don't (lmstudio.openai
// passthrough, raw vLLM). Prefer the `final` channel if present; else
// take everything after the LAST `<|message|>` (the trailing content the
// model wanted us to display) and drop any remaining `<|...|>` markers.
function stripHarmonyTokens(text) {
  if (typeof text !== 'string') return text;
  if (text.indexOf('<|') === -1) return text;
  var finalMatch = text.match(/<\|channel\|>final[^<]*<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|return\|>|<\|channel\|>|$)/);
  if (finalMatch) return finalMatch[1].replace(/<\|[^|]*\|>/g, '').trim();
  var lastMessage = text.lastIndexOf('<|message|>');
  if (lastMessage !== -1) text = text.substring(lastMessage + '<|message|>'.length);
  return text.replace(/<\|[^|]*\|>/g, '').trim();
}

// After Harmony stripping, gpt-oss sometimes leaves an inner JSON payload
// like `{"response":"You told me forty-two."}` or
// `{"role":"assistant","content":"Clouds drift..."}`. On the watch the
// user reads the literal JSON, which is worse than the wrapper was. If
// the remaining content parses as JSON and has a `content` or `response`
// string field, unwrap it. Otherwise leave the text alone — many normal
// responses contain JSON-shaped data legitimately (e.g. recipes,
// code snippets).
function unwrapJsonContent(text) {
  if (typeof text !== 'string') return text;
  var trimmed = text.trim();
  if (trimmed.length < 2 || trimmed[0] !== '{' || trimmed[trimmed.length - 1] !== '}') {
    return text;
  }
  try {
    var obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object') {
      if (typeof obj.content === 'string')  return obj.content;
      if (typeof obj.response === 'string') return obj.response;
    }
  } catch (e) {
    // Not JSON; leave the text as-is.
  }
  return text;
}

// Strip Markdown markup that Pebble fonts render literally. gpt-oss
// emitted `**bold**` in ~40% of testbench replies despite a brevity-
// focused system prompt; other models in the data didn't. Removes the
// markers but preserves the content so meaning survives.
function stripMarkdown(text) {
  if (typeof text !== 'string') return text;
  return text
    // Fenced code blocks ```lang\n ... ```  ->  inner only
    .replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, '$1')
    // Inline code `x`  ->  x
    .replace(/`([^`\n]+)`/g, '$1')
    // Bold ** ** / __ __  ->  inner
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    // Italic * * / _ _ -> inner (anchored so we don't eat single * in code)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1$2')
    // Markdown links [text](url)  ->  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Line-anchored: leading ATX headers, blockquotes, list bullets
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+\.[ \t]+/gm, '');
}

// Replace or drop characters that Pebble's system fonts can't render.
// Targeted ASCII-equivalents first; then strip anything still outside
// ASCII printable + LF + tab to catch the long tail. Final trim removes
// leading blank lines that qwen ("\n\n") and nemotron ("\n") always
// prepend, plus any whitespace exposed by the drop pass.
function sanitizeForPebble(text) {
  if (typeof text !== 'string') return text;
  text = stripHarmonyTokens(text);
  text = unwrapJsonContent(text);
  text = stripMarkdown(text);
  return text
    .replace(/[‐-―−]/g, '-')      // hyphens / en-em dashes / minus
    .replace(/[‘-‛]/g, "'")            // curly single quotes
    .replace(/[“-‟]/g, '"')            // curly double quotes
    .replace(/…/g, '...')                   // horizontal ellipsis
    .replace(/[•‣●◦]/g, '*') // bullets
    .replace(/[  -   　]/g, ' ') // unicode spaces
    .replace(/[^\x09\x0A\x20-\x7E]/g, '')        // drop everything else
    .trim();
}

// --- Chunking + ack-gated send -----------------------------------------

// Split a string into chunks of <= maxBytes bytes when UTF-8 encoded,
// without splitting in the middle of a multibyte codepoint.
function splitUtf8(text, maxBytes) {
  var chunks = [];
  var bytes = unescape(encodeURIComponent(text));  // UTF-8 byte string
  var i = 0;
  while (i < bytes.length) {
    var end = Math.min(i + maxBytes, bytes.length);
    // Walk back to a codepoint boundary if we landed mid-codepoint.
    // A continuation byte has the high two bits == 10xxxxxx (0x80..0xBF).
    while (end > i && end < bytes.length) {
      var code = bytes.charCodeAt(end);
      if ((code & 0xC0) !== 0x80) break;
      end--;
    }
    var slice = bytes.substring(i, end);
    chunks.push(decodeURIComponent(escape(slice)));
    i = end;
  }
  return chunks;
}

// Send `text` to the watch as a series of chunked AppMessages, waiting for an
// application-level ChunkAck (key "ChunkAck") for each chunk before sending
// the next. Returns nothing; calls onComplete() / onError(code) when done.
function sendChunked(text, callbacks) {
  var onComplete = (callbacks && callbacks.onComplete) || function () {};
  var onError = (callbacks && callbacks.onError) || function () {};
  var ERR_RESPONSE_TOO_LARGE = 9;
  var ERR_TRANSPORT_FAILED = 11;

  var chunks = splitUtf8(sanitizeForPebble(text), CHUNK_SIZE);
  if (chunks.length === 0) chunks = [''];
  if (chunks.length > MAX_CHUNKS) {
    sendErrorCode(ERR_RESPONSE_TOO_LARGE);
    onError(ERR_RESPONSE_TOO_LARGE);
    return;
  }

  var idx = 0;
  var ackListener = null;
  var done = false;  // guards the listener once this turn is finished
  var retries = 0;
  var MAX_RETRIES = 3;
  var BACKOFF_MS = [250, 500, 1000];

  // pypkjs (emery emulator) has a buggy removeEventListener that throws
  // a Python-side TypeError on `del listener[i]` (typo: should be `del
  // self.__listeners[event][i]`). The throw propagates back into JS,
  // aborts the caller, and leaves any subsequent JS work undone — which
  // is what caused our turn-1 onComplete to never fire and inflight to
  // stay true forever. Guard against it: wrap removeEventListener in
  // try/catch, and additionally gate the listener on a `done` flag so
  // any stale subscription is a no-op.
  function cleanup() {
    done = true;
    if (ackListener) {
      try {
        Pebble.removeEventListener('appmessage', ackListener);
      } catch (e) {
        // pypkjs bug; the listener stays subscribed but `done` makes it inert.
      }
      ackListener = null;
    }
  }

  function sendChunk(i) {
    var payload = {
      ResponseChunkIndex: i,
      ResponseChunkTotal: chunks.length,
      ResponseChunkText: chunks[i],
    };
    Pebble.sendAppMessage(payload, function () {
      // Transport ack; wait for application-level ChunkAck before advancing.
    }, function () {
      if (retries < MAX_RETRIES) {
        setTimeout(function () { sendChunk(i); }, BACKOFF_MS[retries]);
        retries++;
      } else {
        cleanup();
        sendErrorCode(ERR_TRANSPORT_FAILED);
        onError(ERR_TRANSPORT_FAILED);
      }
    });
  }

  ackListener = function (e) {
    if (done) return;  // stale subscription after cleanup under the pypkjs bug
    var ackIdx = e.payload && e.payload.ChunkAck;
    if (typeof ackIdx !== 'number') return;
    if (ackIdx !== idx) return;  // ignore stale acks
    retries = 0;
    idx++;
    if (idx >= chunks.length) {
      // Order matters: gate + onComplete FIRST so inflight is cleared even
      // if cleanup's removeEventListener throws (pypkjs bug). Otherwise a
      // throw would leave inflight stuck true forever, and every subsequent
      // UserMessage would bounce with ERR_BUSY.
      done = true;
      onComplete();
      cleanup();
    } else {
      sendChunk(idx);
    }
  };
  Pebble.addEventListener('appmessage', ackListener);

  sendChunk(0);
}

function sendErrorCode(code) {
  Pebble.sendAppMessage({ ErrorCode: code });
}

module.exports = {
  CHUNK_SIZE: CHUNK_SIZE,
  MAX_CHUNKS: MAX_CHUNKS,
  splitUtf8: splitUtf8,
  sanitizeForPebble: sanitizeForPebble,
  stripHarmonyTokens: stripHarmonyTokens,
  unwrapJsonContent: unwrapJsonContent,
  stripMarkdown: stripMarkdown,
  sendChunked: sendChunked,
  sendErrorCode: sendErrorCode,
};
