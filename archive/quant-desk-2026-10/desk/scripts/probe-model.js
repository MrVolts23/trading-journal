#!/usr/bin/env node
// Quant Desk — one tiny REAL model call to prove the seam works end to end:
//   node desk/scripts/probe-model.js
// Prints the model that answered, stop_reason, tokens and cost; records the call in desk.db's
// model_calls ledger (role 'probe'). Exits 2 with the add-key command when the keychain has no key.
// Never run this from a test: it spends real money (a fraction of a cent).
const path = require('path');
const keychain = require(path.join(__dirname, '../src/model/keychain'));
const provider = require(path.join(__dirname, '../src/model/provider'));
const budget = require(path.join(__dirname, '../src/budget'));
const desk = require(path.join(__dirname, '../src/db'));

if (!keychain.hasKey()) {
  console.error('No API key in the keychain. Add it once in Terminal (it will prompt for the key, nothing is echoed):');
  console.error(`  ${keychain.ADD_KEY_COMMAND}`);
  process.exit(2);
}

(async () => {
  const cfg = provider.roleConfig('chat');
  const db = desk.getDb();
  const pre = budget.precheck(db, { prompt_tokens: 50, max_tokens: 600, prices: provider.pricesFor(cfg.model) });
  if (!pre.ok) { console.error(`Refused before calling: ${pre.reason}`); process.exit(3); }
  const t0 = Date.now();
  let r;
  try {
    r = await provider.complete({
      role: 'chat', effort: 'low', max_tokens: 600,
      system: 'You are a connectivity probe for a trading research desk. Follow the instruction exactly.',
      messages: [{ role: 'user', content: 'Reply with the single word OK' }],
    });
  } catch (e) {
    budget.recordCall(db, { role: 'probe', provider: cfg.provider, model: cfg.model, usage: null, cost_usd: 0, latency_ms: Date.now() - t0, ok: 0, error: e.plain || e.message });
    console.error(`Probe failed: ${e.plain || e.message}`);
    process.exit(1);
  }
  budget.recordCall(db, { role: 'probe', provider: r.provider, model: r.model, usage: r.usage, cost_usd: r.cost_usd, latency_ms: r.latency_ms, stop_reason: r.stop_reason, ok: 1 });
  console.log(`provider     ${r.provider}`);
  console.log(`model        ${r.model}`);
  console.log(`stop_reason  ${r.stop_reason}`);
  console.log(`reply        ${r.text == null ? '(refused)' : JSON.stringify(r.text.trim())}`);
  console.log(`tokens       in ${r.usage.input_tokens}, out ${r.usage.output_tokens}, cache read ${r.usage.cache_read_input_tokens}, cache write ${r.usage.cache_creation_input_tokens}`);
  console.log(`cost         $${r.cost_usd.toFixed(6)}`);
  console.log(`latency      ${r.latency_ms} ms`);
  const s = budget.statusToday(db);
  console.log(`today        $${s.spent_today_usd.toFixed(4)} of $${s.cap_usd.toFixed(2)} across ${s.calls_today} call(s)`);
  desk.closeDb();
  process.exit(r.stop_reason === 'refusal' ? 4 : 0);
})();
