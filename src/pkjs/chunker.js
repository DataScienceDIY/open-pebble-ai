// UTF-8-safe text chunker + ack-gated AppMessage sender.
// Must stay in sync with C-side CHUNK_SIZE / MAX_CHUNKS in src/c/message_keys.h.

var CHUNK_SIZE = 2048;
var MAX_CHUNKS = 16;

// Replace or drop characters that Pebble's system fonts can't render.
// LLMs commonly emit smart quotes, em-dashes, ellipses, bullets, and various
// Unicode spaces -- all show up as empty boxes on the watch. Apply targeted
// ASCII-equivalent replacements first (preserving meaning), then strip
// anything still outside ASCII printable + LF + tab to catch the long tail.
// Ranges are written as \uXXXX escapes so this source file stays ASCII-safe.
// Strip reasoning-model "Harmony" control tokens. gpt-oss / o1 / similar
// reasoning models structure their output with `<|channel|>analysis<|message|>...`
// and `<|channel|>final<|message|>...` markers; servers usually unwrap them
// but some (lmstudio.openai passthrough, raw vLLM) don't, leaving the raw
// tokens in `message.content`. Prefer the `final` channel if present; else
// take everything after the LAST `<|message|>` (the trailing content the
// model wanted us to display) and strip any remaining `<|...|>` markers.
function stripHarmonyTokens(text) {
  if (typeof text !== 'string') return text;
  if (text.indexOf('<|') === -1) return text;
  var finalMatch = text.match(/<\|channel\|>final[^<]*<\|message\|>([\s\S]*?)(?:<\|end\|>|<\|return\|>|<\|channel\|>|$)/);
  if (finalMatch) return finalMatch[1].replace(/<\|[^|]*\|>/g, '').trim();
  var lastMessage = text.lastIndexOf('<|message|>');
  if (lastMessage !== -1) text = text.substring(lastMessage + '<|message|>'.length);
  return text.replace(/<\|[^|]*\|>/g, '').trim();
}

function sanitizeForPebble(text) {
  if (typeof text !== 'string') return text;
  text = stripHarmonyTokens(text);
  return text
    .replace(/[‐-―−]/g, '-')      // hyphens / en-em dashes / minus
    .replace(/[‘-‛]/g, "'")            // curly single quotes
    .replace(/[“-‟]/g, '"')            // curly double quotes
    .replace(/…/g, '...')                   // horizontal ellipsis
    .replace(/[•‣●◦]/g, '*') // bullets
    .replace(/[  -   　]/g, ' ') // unicode spaces
    .replace(/[^\x09\x0A\x20-\x7E]/g, '');       // drop everything else
}

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
  sendChunked: sendChunked,
  sendErrorCode: sendErrorCode,
};
