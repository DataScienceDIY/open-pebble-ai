var DEFAULT_SYSTEM_PROMPT =
  'Keep responses very brief, a couple sentences at most. ' +
  'The user is reading this on a tiny smartwatch screen.';

var STORAGE_KEY = 'owui_config';

function defaults() {
  return {
    serverUrl: '',
    apiKey: '',
    model: '',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };
}

function load() {
  var cached = null;
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (e) {
    console.log('config load failed: ' + e);
  }
  var d = defaults();
  if (!cached) return d;
  return {
    serverUrl:    cached.serverUrl    || d.serverUrl,
    apiKey:       cached.apiKey       || d.apiKey,
    model:        cached.model        || d.model,
    systemPrompt: cached.systemPrompt || d.systemPrompt,
  };
}

function save(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch (e) {
    console.log('config save failed: ' + e);
  }
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
  defaults: defaults,
  load: load,
  save: save,
};
