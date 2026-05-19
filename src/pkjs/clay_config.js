// Clay form schema for the settings page. Rendered by @rebble/clay; the
// `data:` URL approach the original config_html.js used is rejected by the
// 2026 Pebble Core companion app (ERR_INVALID_URL), and Clay's offline page
// uses an internal URL scheme the app does understand.
//
// `messageKey` here is the lookup name we'll use on the JS side via
// clay.getSettings(); since we drive the autoHandleEvents=false path (see
// pkjs/index.js) and save into localStorage ourselves, these don't need
// to be registered in package.json's messageKeys list — only FontSize is.
//
// System Prompt is intentionally omitted: Clay's input element renders an
// HTML <input>, not <textarea>, so multi-line entry doesn't work. The
// system prompt is settable via scripts/inject-config-defaults.sh and is
// rarely changed at runtime.

module.exports = [
  {
    type: 'heading',
    defaultValue: 'Open Pebble AI',
  },
  {
    type: 'text',
    defaultValue:
      'Configure the LLM endpoint the watch talks to. Server URL and ' +
      'model are required. API key is required for hosted endpoints; ' +
      'leave blank for unauthenticated local servers.',
  },
  {
    type: 'section',
    items: [
      {
        type: 'heading',
        defaultValue: 'Server',
        size: 4,
      },
      {
        type: 'input',
        messageKey: 'serverUrl',
        label: 'Server URL',
        attributes: {
          placeholder: 'https://owui.example.com',
          type: 'url',
          autocomplete: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        },
      },
      {
        type: 'input',
        messageKey: 'apiKey',
        label: 'API key',
        attributes: {
          placeholder: 'sk-...',
          type: 'password',
          autocomplete: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        },
      },
      {
        type: 'input',
        messageKey: 'model',
        label: 'Model',
        attributes: {
          placeholder: 'llama3.2',
          type: 'text',
          autocomplete: 'off',
          autocorrect: 'off',
          spellcheck: 'false',
        },
      },
    ],
  },
  {
    type: 'section',
    items: [
      {
        type: 'heading',
        defaultValue: 'Display',
        size: 4,
      },
      {
        type: 'radiogroup',
        messageKey: 'fontSize',
        label: 'Font size',
        defaultValue: 'medium',
        options: [
          { label: 'Medium', value: 'medium' },
          { label: 'Large', value: 'large' },
        ],
      },
    ],
  },
  {
    type: 'submit',
    defaultValue: 'Save',
  },
];
