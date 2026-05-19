// Self-contained HTML config page, served as a data: URL via Pebble.openURL().
// Current settings are passed in the URL search params (?current=<json>) and
// posted back to PebbleKit JS via pebblejs://close#<json>.

var DEFAULTS = require('./config').defaults();

var HTML =
'<!doctype html>' +
'<html><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Open Pebble AI settings</title>' +
'<style>' +
'body{font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:1em auto;padding:0 1em;color:#222;background:#fafafa}' +
'h1{font-size:1.2em;margin:.5em 0}' +
'label{display:block;margin-top:1em;font-weight:600;font-size:.9em}' +
'input,textarea,select{width:100%;padding:.5em;margin-top:.25em;font:inherit;box-sizing:border-box}' +
'textarea{min-height:5em}' +
'button{margin-top:1em;padding:.6em 1em;font:inherit;border:0;border-radius:4px;background:#0066cc;color:#fff;cursor:pointer}' +
'button.secondary{background:#666}' +
'a{font-size:.85em}' +
'.row{display:flex;gap:.5em;align-items:flex-end}' +
'.row > div{flex:1}' +
'#status{margin-top:.5em;font-size:.9em;color:#666;min-height:1.2em}' +
'</style></head><body>' +
'<h1>Open Pebble AI</h1>' +
'<label>Server URL<input id="serverUrl" type="url" placeholder="https://owui.example.com"></label>' +
'<label>API key<input id="apiKey" type="password" placeholder="sk-..."></label>' +
'<div class="row"><div><label>Model<input id="model" type="text" placeholder="llama3.2"></label></div>' +
'<div><button id="loadModels" class="secondary" type="button">Load models</button></div></div>' +
'<label>System prompt<textarea id="systemPrompt"></textarea></label>' +
'<a href="#" id="resetPrompt">Reset to default</a>' +
'<label>Font size<select id="fontSize">' +
'<option value="medium">Medium (default)</option>' +
'<option value="large">Large</option>' +
'</select></label>' +
'<div class="row" style="margin-top:1em">' +
'<button id="test" class="secondary" type="button">Test connection</button>' +
'<button id="save" type="button">Save</button>' +
'</div>' +
'<div id="status"></div>' +
'<script>' +
'var DEFAULT_PROMPT=' + JSON.stringify(DEFAULTS.systemPrompt) + ';' +
'function $(id){return document.getElementById(id)}' +
'function setStatus(t){$("status").textContent=t}' +
'function getCurrent(){try{var q=new URLSearchParams(location.search).get("current");return q?JSON.parse(q):{}}catch(e){return{}}}' +
'var cur=getCurrent();' +
'$("serverUrl").value=cur.serverUrl||"";' +
'$("apiKey").value=cur.apiKey||"";' +
'$("model").value=cur.model||"";' +
'$("systemPrompt").value=cur.systemPrompt||DEFAULT_PROMPT;' +
'$("fontSize").value=cur.fontSize||"medium";' +
'$("resetPrompt").addEventListener("click",function(e){e.preventDefault();$("systemPrompt").value=DEFAULT_PROMPT});' +
'function authHeader(){var k=$("apiKey").value.trim();return k?{Authorization:"Bearer "+k}:{}}' +
'function url(path){return $("serverUrl").value.replace(/\\/$/,"")+path}' +
'$("loadModels").addEventListener("click",function(){' +
'setStatus("Loading...");' +
'fetch(url("/api/models"),{headers:authHeader()}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(function(j){' +
'var data=j.data||j.models||j;var sel=document.createElement("select");sel.id="model";' +
'(data||[]).forEach(function(m){var o=document.createElement("option");o.value=m.id;o.text=m.id;if(m.id===$("model").value)o.selected=true;sel.appendChild(o)});' +
'$("model").parentNode.replaceChild(sel,$("model"));setStatus("Loaded "+(data.length||0)+" models")' +
'}).catch(function(e){setStatus("Load failed: "+e.message+" (CORS? enter model name manually)")})});' +
'$("test").addEventListener("click",function(){' +
'setStatus("Testing...");' +
'fetch(url("/api/chat/completions"),{method:"POST",headers:Object.assign({"Content-Type":"application/json"},authHeader()),' +
'body:JSON.stringify({model:$("model").value,messages:[{role:"user",content:"ping"}],stream:false})})' +
'.then(function(r){setStatus("HTTP "+r.status+(r.ok?" OK":" — check key/model"))}).catch(function(e){setStatus("Failed: "+e.message)})});' +
'$("save").addEventListener("click",function(){' +
'var cfg={serverUrl:$("serverUrl").value.trim(),apiKey:$("apiKey").value,model:$("model").value.trim(),systemPrompt:$("systemPrompt").value,fontSize:$("fontSize").value};' +
'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(cfg))});' +
'</script></body></html>';

function dataUrl(current) {
  var b64;
  try {
    b64 = btoa(unescape(encodeURIComponent(HTML)));
  } catch (e) {
    b64 = '';
  }
  var qs = current ? ('?current=' + encodeURIComponent(JSON.stringify(current))) : '';
  // Browsers don't honor query strings on data: URLs uniformly; use a hash
  // fallback by appending to the HTML before encoding if needed. For now, the
  // HTML reads window.location.search which works in WebKit on iOS where the
  // querystring rides through; the inner script falls back to {} on failure.
  return 'data:text/html;base64,' + b64 + qs;
}

module.exports = { dataUrl: dataUrl, HTML: HTML };
