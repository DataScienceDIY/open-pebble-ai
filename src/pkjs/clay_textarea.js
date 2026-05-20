// Custom Clay component: multi-line text input (HTML <textarea>).
// Clay 1.0 ships no textarea — only single-line <input> — so the system
// prompt field needs this. Mirrors the built-in `input` component's
// shape (label + control + optional description) and styling so it
// reads consistently with the rest of the form.
//
// The `val` manipulator works on <textarea> just as it does on <input>
// (both expose .value), so no custom get/set is needed.

// Note: no `defaultValue` interpolated into the <textarea> body — Clay's
// `val` manipulator sets .value on the element after construction, using
// either the stored value or `defaultValue`. Putting it in the template
// too would (a) double-set and (b) treat the prompt as raw HTML.
var TEMPLATE =
  '<div class="component component-textarea">' +
    '<label class="tap-highlight">' +
      '<span class="label">{{{label}}}</span>' +
      '<span class="input">' +
        '<textarea data-manipulator-target ' +
          'rows="{{rows}}" ' +
          '{{each key: attributes}}{{key}}="{{this}}" {{/each}}' +
        '></textarea>' +
      '</span>' +
    '</label>' +
    '{{if description}}<div class="description">{{{description}}}</div>{{/if}}' +
  '</div>';

// Style chosen to match Clay's .component-input — same background, padding,
// border-radius, color, focus behaviour. Resize disabled so layout stays
// predictable inside the phone webview.
var STYLE =
  '.component-textarea label{display:block}' +
  '.component-textarea .label{padding-bottom:0.5em}' +
  '.component-textarea .input{position:relative;min-width:100%;margin-top:0.5em;margin-left:0}' +
  '.component-textarea textarea{' +
    'display:block;width:100%;background:#2d2d2d;border-radius:6px;' +
    'padding:0.5em;border:none;color:#fff;font-size:inherit;' +
    'font-family:inherit;line-height:1.4;resize:vertical;' +
    'min-height:6em;box-sizing:border-box;' +
  '}' +
  '.component-textarea textarea:focus{outline:none;border:none;box-shadow:none}' +
  '.component-textarea .description{margin-top:0.5em;opacity:0.7;font-size:0.9em}';

module.exports = {
  name: 'textarea',
  template: TEMPLATE,
  style: STYLE,
  manipulator: 'val',
  defaults: {
    label: '',
    description: '',
    defaultValue: '',
    rows: 5,
    attributes: {},
  },
};
