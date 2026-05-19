// OpenWebUI client. Phase 1: hard-coded OWUI paths.
// Phase 2 (per DESIGN.md §7): switch endpoints() on config.providerType.

var ERR = {
  SERVER_UNREACHABLE: 4,
  BAD_API_KEY: 5,
  ACCESS_DENIED: 6,
  SERVER_ERROR: 7,
  TIMEOUT: 8,
};

var XHR_TIMEOUT_MS = 90000;

function endpoints(config) {
  var base = (config.serverUrl || '').replace(/\/$/, '');
  return {
    chat:   base + '/api/chat/completions',
    models: base + '/api/models',
  };
}

function httpStatusToError(status) {
  if (status === 401) return ERR.BAD_API_KEY;
  if (status === 403) return ERR.ACCESS_DENIED;
  if (status >= 500)  return ERR.SERVER_ERROR;
  return ERR.SERVER_ERROR;
}

// Sends a chat completion request and calls onSuccess(text) or onError(code).
// `messages` is the full conversation array (caller owns it, including the
// system message at index 0). `chatId` ties all turns in one conversation
// together in OWUI's history; it is REQUIRED — OWUI's /api/chat/completions
// errors with 400 ("'NoneType' object has no attribute 'startswith'") when
// chat_id is missing.
function chatCompletion(config, messages, chatId, callbacks) {
  var onSuccess = callbacks.onSuccess;
  var onError = callbacks.onError;
  var url = endpoints(config).chat;

  var body = JSON.stringify({
    model: config.model,
    messages: messages,
    stream: false,
    chat_id: chatId,
    id: chatId,
  });

  var xhr = new XMLHttpRequest();
  xhr.open('POST', url, true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  if (config.apiKey) {
    xhr.setRequestHeader('Authorization', 'Bearer ' + config.apiKey);
  }
  xhr.timeout = XHR_TIMEOUT_MS;

  xhr.ontimeout = function () { onError(ERR.TIMEOUT); };
  xhr.onerror   = function () { onError(ERR.SERVER_UNREACHABLE); };
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      onError(httpStatusToError(xhr.status));
      return;
    }
    try {
      var resp = JSON.parse(xhr.responseText);
      var text = resp.choices && resp.choices[0] &&
                 resp.choices[0].message && resp.choices[0].message.content;
      if (typeof text !== 'string') {
        onError(ERR.SERVER_ERROR);
        return;
      }
      onSuccess(text);
    } catch (e) {
      onError(ERR.SERVER_ERROR);
    }
  };

  xhr.send(body);
  return xhr;
}

// Lists available models for the config page's "Load models" button.
function listModels(config, callbacks) {
  var url = endpoints(config).models;
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  if (config.apiKey) {
    xhr.setRequestHeader('Authorization', 'Bearer ' + config.apiKey);
  }
  xhr.timeout = 15000;
  xhr.ontimeout = function () { callbacks.onError(ERR.TIMEOUT); };
  xhr.onerror   = function () { callbacks.onError(ERR.SERVER_UNREACHABLE); };
  xhr.onload = function () {
    if (xhr.status < 200 || xhr.status >= 300) {
      callbacks.onError(httpStatusToError(xhr.status));
      return;
    }
    try {
      var resp = JSON.parse(xhr.responseText);
      var data = resp.data || resp.models || resp;
      var ids = [];
      if (Array.isArray(data)) {
        for (var i = 0; i < data.length; i++) {
          if (data[i] && data[i].id) ids.push(data[i].id);
        }
      }
      callbacks.onSuccess(ids);
    } catch (e) {
      callbacks.onError(ERR.SERVER_ERROR);
    }
  };
  xhr.send();
  return xhr;
}

module.exports = {
  ERR: ERR,
  endpoints: endpoints,
  chatCompletion: chatCompletion,
  listModels: listModels,
};
