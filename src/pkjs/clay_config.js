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
// The `textarea` type is a custom component registered in pkjs/index.js
// (see clay_textarea.js); Clay 1.0 only ships single-line <input>.

var config = require('./config');

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
    type: 'section',
    items: [
      {
        type: 'heading',
        defaultValue: 'System prompt',
        size: 4,
      },
      {
        type: 'textarea',
        messageKey: 'systemPrompt',
        label: '',
        description:
          'Prepended invisibly to every conversation. Keep it short — ' +
          'long prompts eat tokens and watch screen space.',
        defaultValue: config.DEFAULT_SYSTEM_PROMPT,
        rows: 5,
      },
    ],
  },
  {
    type: 'submit',
    defaultValue: 'Save',
  },
];
