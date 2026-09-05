// Quant Desk — Anthropic backend for provider.js. One function: complete().
//
// Fable 5.1 rules (claude-api skill, read 2026-09-03): thinking is always on so NO thinking param;
// NO temperature / top_p / top_k; NO assistant prefill; NO forced tool_choice. Depth is
// output_config.effort. Structured JSON comes from output_config.format (zodOutputFormat).
// Refusals: opt into the server-side fallback ('default' form needs beta server-side-fallback-2026-07-01)
// and ALWAYS check stop_reason === 'refusal' before reading content.
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const BETAS = ['server-side-fallback-2026-07-01'];
const DEFAULT_TIMEOUT_MS = 120000;

let _client = null;
let _clientKey = null;
function client(apiKey, timeout) {
  if (_client && _clientKey === apiKey) return _client;
  _client = new Anthropic({ apiKey, timeout, maxRetries: 1 });
  _clientKey = apiKey;
  return _client;
}

function normalizeUsage(u) {
  return {
    input_tokens: (u && u.input_tokens) || 0,
    output_tokens: (u && u.output_tokens) || 0,
    cache_read_input_tokens: (u && u.cache_read_input_tokens) || 0,
    cache_creation_input_tokens: (u && u.cache_creation_input_tokens) || 0,
  };
}

// complete({ apiKey, model, system, messages, schema?, max_tokens, effort?, timeout_ms? })
//   → { text, stop_reason, usage, model, latency_ms, refusal? }
// system: a string or an array of text blocks (the first one may carry cache_control).
async function complete({ apiKey, model, system, messages, schema, max_tokens, effort, timeout_ms }) {
  const timeout = timeout_ms || DEFAULT_TIMEOUT_MS;
  const output_config = {};
  if (effort) output_config.effort = effort;
  if (schema) output_config.format = zodOutputFormat(schema);
  const params = {
    model,
    max_tokens,
    system,
    messages,
    betas: BETAS,
    fallbacks: 'default',
  };
  if (Object.keys(output_config).length) params.output_config = output_config;

  const t0 = Date.now();
  const res = await client(apiKey, timeout).beta.messages.create(params, { timeout });
  const latency_ms = Date.now() - t0;
  const usage = normalizeUsage(res.usage);
  const served = res.model || model;

  if (res.stop_reason === 'refusal') {
    const d = res.stop_details || null;
    return {
      text: null, stop_reason: 'refusal', usage, model: served, latency_ms,
      refusal: d ? { category: d.category ?? null, explanation: d.explanation ?? null } : null,
    };
  }
  const text = (res.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  return { text, stop_reason: res.stop_reason || null, usage, model: served, latency_ms };
}

// Typed SDK errors → a plain sentence for Mike. Never string-matches error messages.
function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return { plain: 'the key in the keychain was rejected', kind: 'auth', status: err.status };
  if (err instanceof Anthropic.RateLimitError) return { plain: 'rate limited, try again in a minute', kind: 'rate_limit', status: err.status };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { plain: 'the model took too long to answer; try again', kind: 'timeout', status: null };
  if (err instanceof Anthropic.APIConnectionError) return { plain: 'could not reach the model service; check the connection', kind: 'connection', status: null };
  if (err instanceof Anthropic.APIError) return { plain: `the model service answered ${err.status}: ${err.message}`, kind: 'api', status: err.status };
  return { plain: `the model call failed: ${err && err.message ? err.message : String(err)}`, kind: 'unknown', status: null };
}

function isAuthError(err) { return err instanceof Anthropic.AuthenticationError; }

module.exports = { complete, describeError, isAuthError, normalizeUsage, BETAS, DEFAULT_TIMEOUT_MS };
