#!/usr/bin/env node
// Standalone diagnostic: hits the OWUI chat-completions endpoint with the
// exact same request shape src/pkjs/owui.js uses, then runs each raw reply
// through src/pkjs/chunker.js::sanitizeForPebble so we can see exactly
// what would land on the watch. Bypasses the app entirely — no emulator,
// no pypkjs, no Bluetooth.
//
// Usage:
//   node scripts/api-testbench.js [options] [prompt ...]
//     --iterations N    Repeat the full prompt sequence N times (default 10)
//     --prompts FILE    One prompt per line (instead of trailing args / default)
//     --output PATH     Where to write the report (default appstore/diagnostics/...)
//     --system "STR"    Override the system prompt
//     --model "ID"      Override OWUI_MODEL from .env.local (e.g. for
//                       cross-model formatting comparison runs)
//     --quiet           Don't tee to stdout; only write the file
//
// Requires Node 18+ (uses built-in fetch).

'use strict';

const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');

const config = require(path.join(REPO, 'src/pkjs/config.js'));
const chunker = require(path.join(REPO, 'src/pkjs/chunker.js'));

const DEFAULT_PROMPTS = [
  'remember the number forty two',
  'what number did I tell you?',
  'tell me a short haiku about clouds',
];

// --- arg parsing ------------------------------------------------------
function parseArgs(argv) {
  const out = { iterations: 10, prompts: null, output: null, system: null, model: null, quiet: false, trailing: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--iterations': out.iterations = parseInt(argv[++i], 10); break;
      case '--prompts':    out.prompts = argv[++i]; break;
      case '--output':     out.output = argv[++i]; break;
      case '--system':     out.system = argv[++i]; break;
      case '--model':      out.model = argv[++i]; break;
      case '--quiet':      out.quiet = true; break;
      case '-h':
      case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).join('\n').replace(/^\/\/ ?/gm, ''));
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) { console.error('Unknown flag:', a); process.exit(2); }
        out.trailing.push(a);
    }
  }
  if (!Number.isFinite(out.iterations) || out.iterations < 1) {
    console.error('--iterations must be a positive integer');
    process.exit(2);
  }
  return out;
}

// --- .env.local loading -----------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(REPO, '.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('Missing .env.local at', envPath);
    process.exit(2);
  }
  const result = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[m[1]] = value;
  }
  return result;
}

// --- prompt loading ---------------------------------------------------
function loadPrompts(args) {
  if (args.prompts) {
    return fs.readFileSync(args.prompts, 'utf8').split('\n')
      .map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  }
  if (args.trailing.length > 0) return args.trailing;
  return DEFAULT_PROMPTS.slice();
}

// --- HTTP -------------------------------------------------------------
async function postChatCompletion({ host, key, model, messages, chatId }) {
  const url = host.replace(/\/$/, '') + '/api/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = 'Bearer ' + key;
  const body = JSON.stringify({
    model: model,
    messages: messages,
    stream: false,
    chat_id: chatId,
    id: chatId,
  });
  const t0 = Date.now();
  const resp = await fetch(url, { method: 'POST', headers, body });
  const elapsedMs = Date.now() - t0;
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: resp.status, elapsedMs, raw: text, json, requestBody: body };
}

// --- output sink (tee to file + optional stdout) ----------------------
function makeSink(filepath, alsoStdout) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const fd = fs.openSync(filepath, 'w');
  return {
    write(s) {
      fs.writeSync(fd, s);
      if (alsoStdout) process.stdout.write(s);
    },
    line(s = '') { this.write(s + '\n'); },
    close() { fs.closeSync(fd); },
  };
}

function indentBlock(s, prefix = '  ') {
  return s.split('\n').map((line) => prefix + line).join('\n');
}

// --- main -------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnvLocal();
  const host = env.OWUI_HOST;
  const key = env.OWUI_KEY || '';
  const model = args.model || env.OWUI_MODEL;
  if (!host || !model) {
    console.error('OWUI_HOST and OWUI_MODEL must be set in .env.local');
    process.exit(2);
  }

  const systemPrompt = args.system != null
    ? args.system
    : (env.OWUI_SYSTEM_PROMPT || config.DEFAULT_SYSTEM_PROMPT);

  const prompts = loadPrompts(args);
  if (prompts.length === 0) {
    console.error('No prompts to run');
    process.exit(2);
  }

  const startStamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Model id may contain slashes ("lmstudio.openai/gpt-oss-20b") and dots;
  // squash to a filename-safe slug so the four-model runs land in
  // distinguishable files.
  const modelSlug = model.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  const outPath = args.output
    || path.join(REPO, 'appstore/diagnostics', `api-testbench-${modelSlug}-${startStamp}.txt`);
  const sink = makeSink(outPath, !args.quiet);
  const tee = sink; // alias for clarity

  const HRULE = '='.repeat(72);
  const SECT  = '-'.repeat(40);

  tee.line(HRULE);
  tee.line(`API testbench run ${new Date().toISOString()}`);
  tee.line(`host=${host}  model=${model}`);
  tee.line(`system prompt: ${JSON.stringify(systemPrompt)}`);
  tee.line(`iterations: ${args.iterations}`);
  tee.line(`prompts:`);
  prompts.forEach((p, i) => tee.line(`  ${i + 1}. ${p}`));
  tee.line(HRULE);
  tee.line();

  const latencies = [];
  let successes = 0, failures = 0;

  for (let iter = 1; iter <= args.iterations; iter++) {
    const runStamp = startStamp.replace(/-/g, '').slice(0, 15);
    const chatId = `testbench-${runStamp}-${iter}`;
    const conversation = [{ role: 'system', content: systemPrompt }];

    tee.line(`### Iteration ${iter}/${args.iterations}  chat_id=${chatId} ###`);
    tee.line();

    let firstRequestPrinted = (iter !== 1);  // only print request body on iter 1

    for (let t = 0; t < prompts.length; t++) {
      const prompt = prompts[t];
      conversation.push({ role: 'user', content: prompt });

      tee.line(`--- Turn ${t + 1}/${prompts.length} ---`);
      tee.line(`> ${prompt}`);

      let result;
      try {
        result = await postChatCompletion({ host, key, model, messages: conversation, chatId });
      } catch (e) {
        failures++;
        tee.line(`HTTP ERROR: ${e.message}`);
        tee.line();
        conversation.pop();  // roll back the user message we just appended
        continue;
      }

      latencies.push(result.elapsedMs);

      if (!firstRequestPrinted) {
        tee.line(`Outgoing request body (shown once, iteration 1):`);
        try {
          const pretty = JSON.stringify(JSON.parse(result.requestBody), null, 2);
          tee.line(indentBlock(pretty));
        } catch (e) {
          tee.line(indentBlock(result.requestBody));
        }
        firstRequestPrinted = true;
      }

      tee.line(`HTTP ${result.status} in ${result.elapsedMs}ms`);

      if (result.status < 200 || result.status >= 300) {
        failures++;
        tee.line(`Body (${result.raw.length} chars):`);
        tee.line(indentBlock(result.raw.slice(0, 1000)));
        tee.line();
        conversation.pop();
        continue;
      }

      const content = result.json && result.json.choices && result.json.choices[0]
                    && result.json.choices[0].message && result.json.choices[0].message.content;
      if (typeof content !== 'string') {
        failures++;
        tee.line(`No string content in response. Body:`);
        tee.line(indentBlock(JSON.stringify(result.json, null, 2).slice(0, 1000)));
        tee.line();
        conversation.pop();
        continue;
      }

      successes++;

      tee.line(`RAW (${content.length} chars):`);
      tee.line(indentBlock(content));

      const sanitized = chunker.sanitizeForPebble(content);
      tee.line(`SANITIZED (${sanitized.length} chars):`);
      tee.line(indentBlock(sanitized));
      tee.line();

      // Append the assistant message so the next turn sees a coherent
      // conversation, exactly as PKJS does.
      conversation.push({ role: 'assistant', content: content });
    }
    tee.line();
  }

  // Summary
  latencies.sort((a, b) => a - b);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0;
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;

  tee.line(HRULE);
  tee.line(`Summary: ${args.iterations} iterations x ${prompts.length} turns = ${args.iterations * prompts.length} API calls.`);
  tee.line(`         ${successes} succeeded, ${failures} failed.`);
  tee.line(`         Median latency: ${median}ms per call. P95: ${p95}ms.`);
  tee.line(HRULE);

  sink.close();

  if (args.quiet) console.error(`Wrote ${outPath}`);
  process.exit(failures > 0 ? 1 : 0);
}

// Only auto-run when invoked as a script; importing this file for testing
// (or sanity-checks) shouldn't fire off a 30-call run.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { postChatCompletion, loadEnvLocal, loadPrompts };
