// UTF-8-safe text chunker + ack-gated AppMessage sender.
// Must stay in sync with C-side CHUNK_SIZE / MAX_CHUNKS in src/c/message_keys.h.

var CHUNK_SIZE = 2048;
var MAX_CHUNKS = 16;

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

  var chunks = splitUtf8(text, CHUNK_SIZE);
  if (chunks.length === 0) chunks = [''];
  if (chunks.length > MAX_CHUNKS) {
    sendErrorCode(ERR_RESPONSE_TOO_LARGE);
    onError(ERR_RESPONSE_TOO_LARGE);
    return;
  }

  var idx = 0;
  var ackListener = null;
  var retries = 0;
  var MAX_RETRIES = 3;
  var BACKOFF_MS = [250, 500, 1000];

  function cleanup() {
    if (ackListener) {
      Pebble.removeEventListener('appmessage', ackListener);
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
    var ackIdx = e.payload && e.payload.ChunkAck;
    if (typeof ackIdx !== 'number') return;
    if (ackIdx !== idx) return;  // ignore stale acks
    retries = 0;
    idx++;
    if (idx >= chunks.length) {
      cleanup();
      onComplete();
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
  sendChunked: sendChunked,
  sendErrorCode: sendErrorCode,
};
