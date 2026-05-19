var config = require('./config');
var owui = require('./owui');
var chunker = require('./chunker');
var configHtml = require('./config_html');

// In-memory conversation; reset on app exit, on ResetConversation, or on
// system-prompt change in the config page.
var conversation = null;
var chatId = null;
var inflight = false;

function buildConversation(systemPrompt) {
  return [{ role: 'system', content: systemPrompt || '' }];
}

function newChatId() {
  // OWUI accepts any stable string; we just need uniqueness per conversation.
  return 'watch-' + Date.now().toString(36) + '-' +
         Math.floor(Math.random() * 1e9).toString(36);
}

function resetConversation(cfg) {
  conversation = buildConversation(cfg.systemPrompt);
  chatId = newChatId();
}

function handleUserMessage(text) {
  if (inflight) {
    chunker.sendErrorCode(12 /* ERR_BUSY */);
    return;
  }
  var cfg = config.load();
  if (!cfg.serverUrl || !cfg.model) {
    chunker.sendErrorCode(5 /* ERR_BAD_API_KEY — re-purposed; open settings */);
    return;
  }
  if (!conversation) resetConversation(cfg);

  conversation.push({ role: 'user', content: text });
  inflight = true;

  owui.chatCompletion(cfg, conversation, chatId, {
    onSuccess: function (reply) {
      conversation.push({ role: 'assistant', content: reply });
      chunker.sendChunked(reply, {
        onComplete: function () { inflight = false; },
        onError: function () {
          inflight = false;
          // Roll back the assistant message if we couldn't deliver it — the
          // watch never saw it, so the JS-side state must match.
          conversation.pop();
        },
      });
    },
    onError: function (code) {
      // Roll back the user message we just appended — request didn't succeed.
      conversation.pop();
      inflight = false;
      chunker.sendErrorCode(code);
    },
  });
}

Pebble.addEventListener('ready', function () {
  console.log('owui pkjs ready');
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (typeof p.UserMessage === 'string') {
    handleUserMessage(p.UserMessage);
  } else if (p.ResetConversation) {
    resetConversation(config.load());
  } else if (p.CancelInflight) {
    // XHR cancellation requires holding the xhr reference; v1 just lets the
    // in-flight request complete and ignores its result via the inflight flag.
    inflight = false;
    conversation && conversation.length > 1 && conversation.pop();
  }
  // ChunkAck messages are handled inside chunker.sendChunked's listener.
});

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(configHtml.dataUrl(config.load()));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  try {
    var cfg = JSON.parse(decodeURIComponent(e.response));
    config.save(cfg);
    // System-prompt change: rebuild messages[0] in place so subsequent turns
    // use the new instruction without losing in-progress conversation.
    if (conversation && conversation.length > 0) {
      conversation[0] = { role: 'system', content: cfg.systemPrompt || '' };
    }
  } catch (err) {
    console.log('webviewclosed parse failed: ' + err);
  }
});
