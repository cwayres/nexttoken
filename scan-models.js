#!/usr/bin/env node
// scan-models.js
// ---------------------------------------------------------------
// Scans Ollama and LM Studio for available models, probes each
// one for logprobs support with a minimal single-token request,
// unloads after each test, and writes supported.json.
//
// Reads scan-history.json to skip models already tested. Use
// --rescan to ignore history and re-test everything.
//
// Provider-specific logprobs endpoints:
//   - Ollama: /api/chat with logprobs:true (requires v0.12.11+)
//   - LM Studio: /v1/responses with include:["message.output_text.logprobs"]
//
// Usage:
//   node scan-models.js                     # scan both providers
//   node scan-models.js --ollama            # scan Ollama only
//   node scan-models.js --lmstudio          # scan LM Studio only
//   node scan-models.js --rescan            # ignore history, test all
//   node scan-models.js --ollama-url http://host:port
//   node scan-models.js --lmstudio-url http://host:port

const fs = require('fs');
const path = require('path');

// --- CLI args ---
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flagVal = (name) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };

const ollamaOnly = flag('--ollama');
const lmstudioOnly = flag('--lmstudio');
const rescan = flag('--rescan');
const scanOllama = !lmstudioOnly;
const scanLmstudio = !ollamaOnly;

const OLLAMA_ORIGIN = flagVal('--ollama-url') || 'http://localhost:11434';
const LMSTUDIO_ORIGIN = flagVal('--lmstudio-url') || 'http://localhost:1234';

const OUTPUT_FILE = path.join(__dirname, 'supported.json');
const HISTORY_FILE = path.join(__dirname, 'scan-history.json');
const PROBE_TIMEOUT_MS = 90000; // 90s per model probe (some models are slow to load)

// Models that can't generate text (embeddings, rerankers) — skip these
const SKIP_PATTERNS = [
  /embed/i,
  /reranker/i,
  /bge-/i,
  /nomic-embed/i,
];

function shouldSkipModel(modelId) {
  return SKIP_PATTERNS.some((p) => p.test(modelId));
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return bytes + ' B';
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

// --- Scan history ---

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (err) {
    log(`Warning: could not read ${HISTORY_FILE}: ${err.message}`);
  }
  return { models: {} };
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function historyKey(provider, modelId) {
  return `${provider}:${modelId}`;
}

// --- Ollama ---

async function ollamaListModels() {
  const resp = await fetch(`${OLLAMA_ORIGIN}/api/tags`);
  if (!resp.ok) throw new Error(`Ollama /api/tags returned ${resp.status}`);
  const data = await resp.json();
  return (data.models || []).map((m) => ({
    id: m.name || m.model,
    provider: 'ollama',
    size_bytes: m.size || null,
    size_display: formatBytes(m.size),
    parameter_size: m.details?.parameter_size || '',
    quantization: m.details?.quantization_level || '',
    family: m.details?.family || '',
    format: m.details?.format || '',
  }));
}

async function ollamaProbeLogprobs(modelId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const resp = await fetch(`${OLLAMA_ORIGIN}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'The capital of France is' }],
        stream: false,
        logprobs: true,
        top_logprobs: 1,
        options: { num_predict: 2 },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { supported: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }

    const data = await resp.json();
    const hasLogprobs = Array.isArray(data.logprobs) && data.logprobs.length > 0
      && typeof data.logprobs[0].logprob === 'number';

    return { supported: hasLogprobs, error: hasLogprobs ? null : 'logprobs array empty or missing' };
  } catch (err) {
    return { supported: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function ollamaUnload(modelId) {
  try {
    await fetch(`${OLLAMA_ORIGIN}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, keep_alive: 0 }),
    });
  } catch {
    // best-effort unload
  }
}

// --- LM Studio ---

// Use `lms ls --json --llm` for rich metadata (sizeBytes, paramsString, architecture, quantization).
// The /v1/models API only returns {id, object, owned_by} with no size or param info.
const { execSync } = require('child_process');

function lmstudioListFromCli() {
  try {
    const output = execSync('lms ls --json --llm', { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    const models = JSON.parse(output);
    if (!Array.isArray(models) || models.length === 0) return null;

    return models
      .filter((m) => m.type === 'llm' || m.type === 'vlm')
      .map((m) => ({
        id: m.modelKey || m.id,
        provider: 'lmstudio',
        size_bytes: m.sizeBytes || null,
        size_display: formatBytes(m.sizeBytes) || '',
        parameter_size: m.paramsString || '',
        quantization: m.quantization?.name || '',
        quantization_bits: m.quantization?.bits || null,
        family: m.architecture || '',
        format: m.format || '',
        max_context_length: m.maxContextLength || null,
        vision: m.vision || false,
      }));
  } catch {
    return null; // lms not installed or failed
  }
}

async function lmstudioListFromApi() {
  const resp = await fetch(`${LMSTUDIO_ORIGIN}/v1/models`);
  if (!resp.ok) throw new Error(`LM Studio /v1/models returned ${resp.status}`);
  const data = await resp.json();

  return (data.data || []).map((m) => ({
    id: m.id,
    provider: 'lmstudio',
    size_bytes: null,
    size_display: '',
    parameter_size: '',
    quantization: '',
    family: '',
    format: '',
  }));
}

async function lmstudioListModels() {
  // Try CLI first for rich metadata, fall back to API
  const cliModels = lmstudioListFromCli();
  if (cliModels) {
    log('  (using lms CLI for model metadata)');
    return cliModels;
  }
  log('  (lms CLI not available, falling back to /v1/models API — metadata will be limited)');
  return lmstudioListFromApi();
}

async function lmstudioProbeLogprobs(modelId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // Use /v1/responses (Open Responses spec) — this is the endpoint
    // that actually supports logprobs in LM Studio. The /v1/chat/completions
    // endpoint silently ignores the logprobs parameter.
    const resp = await fetch(`${LMSTUDIO_ORIGIN}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        input: 'The capital of France is',
        include: ['message.output_text.logprobs'],
        top_logprobs: 1,
        max_output_tokens: 2,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { supported: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }

    const data = await resp.json();

    // /v1/responses shape: output[0].content[0].logprobs[]
    const output = data?.output?.[0];
    const content = output?.content?.[0];
    const logprobs = content?.logprobs;
    const hasLogprobs = Array.isArray(logprobs) && logprobs.length > 0
      && typeof logprobs[0].logprob === 'number';

    return { supported: hasLogprobs, error: hasLogprobs ? null : 'logprobs array empty or missing in /v1/responses' };
  } catch (err) {
    return { supported: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function lmstudioUnload(modelId) {
  try {
    await fetch(`${LMSTUDIO_ORIGIN}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: modelId }),
    });
  } catch {
    // best-effort unload
  }
}

// --- Main ---

async function scanProvider(name, listFn, probeFn, unloadFn, history) {
  log(`Scanning ${name}...`);
  let models;
  try {
    models = await listFn();
  } catch (err) {
    log(`  Could not connect to ${name}: ${err.message}`);
    return [];
  }

  log(`  Found ${models.length} model(s)`);
  const results = [];
  let skipped = 0;
  let skippedEmbed = 0;

  for (const model of models) {
    // Skip embedding/reranker models — they can't generate text
    if (shouldSkipModel(model.id)) {
      log(`  Skipping: ${model.id} — embedding/reranker model`);
      skippedEmbed++;
      continue;
    }

    const key = historyKey(model.provider, model.id);
    const cached = history.models[key];

    if (!rescan && cached) {
      log(`  Skipping: ${model.id} — already scanned (${cached.logprobs_supported ? 'supported' : 'unsupported'})`);
      results.push({
        ...model,
        logprobs_supported: cached.logprobs_supported,
        probe_error: cached.probe_error || null,
        scanned_at: cached.scanned_at,
      });
      skipped++;
      continue;
    }

    log(`  Testing: ${model.id} (${model.parameter_size || '?'} params, ${model.quantization || '?'} quant, ${model.size_display || '?'})...`);

    const probe = await probeFn(model.id);

    log(`    → ${probe.supported ? 'SUPPORTED' : 'NOT SUPPORTED'}${probe.error ? ' (' + probe.error + ')' : ''}`);

    const result = {
      ...model,
      logprobs_supported: probe.supported,
      probe_error: probe.error || null,
      scanned_at: new Date().toISOString(),
    };

    results.push(result);

    // Update history immediately after each probe
    history.models[key] = {
      id: model.id,
      provider: model.provider,
      logprobs_supported: probe.supported,
      probe_error: probe.error || null,
      scanned_at: result.scanned_at,
      parameter_size: model.parameter_size,
      quantization: model.quantization,
      family: model.family,
    };
    saveHistory(history);

    log(`    Unloading ${model.id}...`);
    await unloadFn(model.id);
    // Brief pause to let memory free
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (skippedEmbed > 0) log(`  Skipped ${skippedEmbed} embedding/reranker model(s)`);
  if (skipped > 0) log(`  Skipped ${skipped} previously scanned model(s)`);

  return results;
}

async function main() {
  log('=== Next Token Explorer — Autoregressive Logprobs Scanner ===');
  if (rescan) log('  --rescan: ignoring previous scan history');
  log('');

  const history = rescan ? { models: {} } : loadHistory();
  const existingCount = Object.keys(history.models).length;
  if (existingCount > 0 && !rescan) {
    log(`Loaded scan history: ${existingCount} model(s) previously scanned`);
    log('');
  }

  const allResults = [];

  if (scanOllama) {
    const results = await scanProvider('Ollama', ollamaListModels, ollamaProbeLogprobs, ollamaUnload, history);
    allResults.push(...results);
  }

  if (scanLmstudio) {
    const results = await scanProvider('LM Studio', lmstudioListModels, lmstudioProbeLogprobs, lmstudioUnload, history);
    allResults.push(...results);
  }

  const supported = allResults.filter((m) => m.logprobs_supported);
  const unsupported = allResults.filter((m) => !m.logprobs_supported);

  const output = {
    scanned_at: new Date().toISOString(),
    total_scanned: allResults.length,
    total_supported: supported.length,
    total_unsupported: unsupported.length,
    supported,
    unsupported,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  saveHistory(history);

  log('');
  log(`Results written to ${OUTPUT_FILE}`);
  log(`Scan history saved to ${HISTORY_FILE}`);
  log(`  Supported: ${supported.length} model(s)`);
  log(`  Unsupported: ${unsupported.length} model(s)`);

  if (supported.length > 0) {
    log('');
    log('Supported models:');
    for (const m of supported) {
      log(`  [${m.provider}] ${m.id} — ${m.parameter_size} ${m.quantization} (${m.size_display})`);
    }
  }

  if (unsupported.length > 0) {
    log('');
    log('Unsupported models:');
    for (const m of unsupported) {
      log(`  [${m.provider}] ${m.id} — ${m.probe_error}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
