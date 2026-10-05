// Quant Desk — local (M5 Ultra, later) backend for provider.js. OpenAI-compatible
// POST {base_url}/v1/chat/completions with response_format json_schema. A stub until models.yaml
// sets providers.local.base_url: without it every call throws 'local provider not configured'.
const { z } = require('zod');

const DEFAULT_TIMEOUT_MS = 120000;

function flattenSystem(system) {
  if (Array.isArray(system)) return system.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n\n');
  return system == null ? '' : String(system);
}
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n');
  return content == null ? '' : String(content);
}

// Same output shape as anthropic.complete: { text, stop_reason, usage, model, latency_ms }
async function complete({ base_url, model, system, messages, schema, max_tokens, timeout_ms }) {
  if (!base_url) throw new Error('local provider not configured');
  const body = {
    model: model || 'default',
    max_tokens,
    messages: [
      { role: 'system', content: flattenSystem(system) },
      ...(messages || []).map((m) => ({ role: m.role, content: flattenContent(m.content) })),
    ],
  };
  if (schema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'desk_reply', strict: true, schema: z.toJSONSchema(schema) },
    };
  }
  const t0 = Date.now();
  const res = await fetch(`${String(base_url).replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout_ms || DEFAULT_TIMEOUT_MS),
  });
  const latency_ms = Date.now() - t0;
  if (!res.ok) {
    const err = new Error(`local model answered ${res.status}`);
    err.plain = `the local model answered ${res.status}`;
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const choice = (data.choices || [])[0] || {};
  const u = data.usage || {};
  const usage = {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    cache_read_input_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    cache_creation_input_tokens: 0,
  };
  const finish = choice.finish_reason || null;
  const stop_reason = finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : finish ? 'end_turn' : null;
  const text = stop_reason === 'refusal' ? null : flattenContent(choice.message && choice.message.content);
  return { text, stop_reason, usage, model: data.model || model || 'local', latency_ms };
}

module.exports = { complete, DEFAULT_TIMEOUT_MS };
