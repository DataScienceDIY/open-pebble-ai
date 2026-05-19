var Clay = require('@rebble/clay');
var clayConfig = require('./clay_config');
var config = require('./config');
var owui = require('./owui');
var chunker = require('./chunker');

// autoHandleEvents: false — we attach our own showConfiguration and
// webviewclosed listeners so submitted values go into PKJS localStorage
// (not pushed to the watch via AppMessage with unregistered keys).
var clay = new Clay(clayConfig, null, { autoHandleEvents: false });

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

function pushFontSize(cfg) {
  Pebble.sendAppMessage({ FontSize: config.fontSizeCode(cfg.fontSize) });
}

Pebble.addEventListener('ready', function () {
  console.log('owui pkjs ready');
  pushFontSize(config.load());
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
  // Pre-seed Clay's form with current values so the user sees what's set.
  // clay.generateUrl() bakes in clay.meta + current values from
  // localStorage; we ensure localStorage has the merged result of baked
  // defaults + any prior settings.
  var current = config.load();
  // Clay reads its initial values from localStorage by messageKey, so
  // mirror our config keys there before opening the page.
  for (var k in current) {
    if (current.hasOwnProperty(k)) {
      try { localStorage.setItem('clay-settings:' + k, JSON.stringify(current[k])); } catch (e) {}
    }
  }
  Pebble.openURL(clay.generateUrl());
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response) return;
  try {
    // Clay returns { messageKey: { value: x } }; getSettings with convert=false
    // preserves that shape (otherwise it tries to map to AppMessage int keys).
    var settings = clay.getSettings(e.response, false);
    var cfg = config.load();  // start from current baked + saved defaults
    for (var k in settings) {
      if (settings.hasOwnProperty(k) && settings[k] && 'value' in settings[k]) {
        cfg[k] = settings[k].value;
      }
    }
    config.save(cfg);
    // System-prompt change: rebuild messages[0] in place so subsequent turns
    // use the new instruction without losing in-progress conversation.
    if (conversation && conversation.length > 0) {
      conversation[0] = { role: 'system', content: cfg.systemPrompt || '' };
    }
    pushFontSize(cfg);  // takes effect on next render
  } catch (err) {
    console.log('webviewclosed parse failed: ' + err);
  }
});
