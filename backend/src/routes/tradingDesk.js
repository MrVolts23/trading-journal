// Trading Desk — API for the Trainer tab. Own database, own folder; journal.db is never touched here.
const express = require('express');
const zlib = require('zlib');
const store = require('../tradingDesk/store');
const history = require('../tradingDesk/history');
const clef = require('../tradingDesk/clef');

const router = express.Router();
const wrap = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (e) { if (!e.status) console.error('[trading-desk]', req.method, req.path, e.message); res.status(e.status || 500).json({ error: e.message }); }
};

// What the tab needs to know on open: how much history is loaded, is a fetch running, is the robot there.
const sym = (req) => { const s = String((req.query && req.query.symbol) || (req.body && req.body.symbol) || store.SYMBOL).toUpperCase(); return store.listInstruments().some((i) => i.symbol === s) ? s : store.SYMBOL; };

router.get('/status', wrap((req, res) => {
  res.json({ ...history.status(sym(req)), timeframes: store.TIMEFRAMES, symbol: sym(req), instruments: store.listInstruments() });
}));

// Fetch history through the demo MetaTrader's data robot. { months: 12 } or { from: 'YYYY-MM-DD' }
router.post('/history', wrap((req, res) => {
  const b = req.body || {};
  res.json({ pending: history.request({ months: Number(b.months) > 0 ? Number(b.months) : 12, from: b.from || null, symbol: sym(req) }) });
}));

// Add the newest bars from the robot's rolling file (cheap; the tab calls it when it opens).
router.post('/history/top-up', wrap((req, res) => {
  res.json({ added: history.topUp(), coverage: store.coverage(sym(req)) });
}));

// All candles for one timeframe, with both EMAs, as compact arrays (gzipped: a year of 3-minute bars is a few MB).
router.get('/bars', wrap((req, res) => {
  const tf = Number(req.query.tf);
  const data = store.candles(tf, sym(req));
  const body = zlib.gzipSync(JSON.stringify(data));
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}));

// Where point 4 lands for a 1-2-3 entry (see store.findEntryMoment). { side, after_t, entry, invalid }
router.post('/entry-moment', wrap((req, res) => {
  const b = req.body || {};
  for (const k of ['after_t', 'entry']) if (!Number.isFinite(b[k])) return res.status(400).json({ error: `${k} is missing` });
  if (!['long', 'short'].includes(b.side)) return res.status(400).json({ error: 'side must be long or short' });
  res.json(store.findEntryMoment({ side: b.side, after_t: b.after_t, entry: b.entry, invalid: Number.isFinite(b.invalid) ? b.invalid : null, symbol: sym(req) }));
}));

// Instruments the desk can be taught on (gold and anything added from the Edge tab).
router.get('/instruments', wrap((req, res) => { res.json(store.listInstruments()); }));
router.post('/instruments', wrap((req, res) => { res.json(store.addInstrument(req.body || {})); }));

// Clef: ask the local decision model about a saved example, one record per taught skill.
const awrap = (fn) => (req, res) => fn(req, res).catch((e) => { if (!e.status) console.error('[trading-desk] clef', e.message); res.status(e.status || 500).json({ error: e.message }); });
router.get('/clef/status', awrap(async (req, res) => { res.json(await clef.status()); }));
router.post('/clef/start', awrap(async (req, res) => { await clef.ensure(); res.json(await clef.status()); }));
router.post('/clef/ask/:id', awrap(async (req, res) => { res.json(await clef.askExample(Number(req.params.id), Array.isArray(req.body?.skills) ? req.body.skills : null)); }));
router.get('/clef/runs', wrap((req, res) => { const e = Number(req.query.example); res.json(Number.isInteger(e) && e > 0 ? clef.runsFor(e) : clef.allRuns()); }));

// Skills: the library of judgements (taught) and rules (arithmetic) that edges are built from.
router.get('/skills', wrap((req, res) => { res.json({ skills: store.listSkills(), categories: store.SKILL_CATEGORIES }); }));
router.post('/skills', wrap((req, res) => { res.json(store.createSkill(req.body || {})); }));
router.put('/skills/:key', wrap((req, res) => { res.json(store.updateSkill(String(req.params.key), req.body || {})); }));
router.delete('/skills/:key', wrap((req, res) => { res.json(store.deleteSkill(String(req.params.key))); }));

// Risk profiles: how much an ACCOUNT may risk (not an edge property).
router.get('/risk', wrap((req, res) => { res.json(store.listRiskProfiles()); }));
router.post('/risk', wrap((req, res) => { res.json(store.createRiskProfile(req.body || {})); }));
router.put('/risk/:id', wrap((req, res) => { res.json(store.updateRiskProfile(Number(req.params.id), req.body || {})); }));
router.delete('/risk/:id', wrap((req, res) => { res.json(store.deleteRiskProfile(Number(req.params.id))); }));

// Exit plans: named lists of exit triggers, shared by edges; each example records the one it was taught with.
router.get('/exits', wrap((req, res) => { res.json({ plans: store.listExitPlans(), types: store.EXIT_TRIGGER_TYPES }); }));
router.post('/exits', wrap((req, res) => { res.json(store.createExitPlan(req.body || {})); }));
router.put('/exits/:id', wrap((req, res) => { res.json(store.updateExitPlan(Number(req.params.id), req.body || {})); }));
router.delete('/exits/:id', wrap((req, res) => { res.json(store.deleteExitPlan(Number(req.params.id))); }));

// Edges: one rulebook each; examples live under an edge.
router.get('/edges', wrap((req, res) => { res.json(store.listEdges()); }));
router.post('/edges', wrap((req, res) => { res.json(store.createEdge(req.body || {})); }));
router.put('/edges/:id', wrap((req, res) => { res.json(store.updateEdge(Number(req.params.id), req.body || {})); }));
router.get('/edges/:id/counts', wrap((req, res) => { res.json(store.edgeCounts(Number(req.params.id))); }));
// Permanent: the edge, its examples and its removed examples go (pictures land in the trash folder).
router.delete('/edges/:id', wrap((req, res) => { res.json(store.deleteEdge(Number(req.params.id))); }));

router.get('/examples', wrap((req, res) => { const e = Number(req.query.edge); res.json(store.listExamples(Number.isInteger(e) && e > 0 ? e : null, req.query.skill ? String(req.query.skill) : null)); }));
router.get('/examples/:id', wrap((req, res) => {
  const ex = store.getExample(Number(req.params.id));
  if (!ex) return res.status(404).json({ error: 'That example no longer exists.' });
  res.json(ex);
}));
router.post('/examples', wrap((req, res) => { res.json(store.saveExample(req.body || {})); }));
router.put('/examples/:id', wrap((req, res) => { res.json(store.saveExample(req.body || {}, Number(req.params.id))); }));
router.patch('/examples/:id', wrap((req, res) => { res.json(store.patchExample(Number(req.params.id), req.body || {})); }));
// Removed examples: listed, viewable, and can be put back.
router.get('/removed', wrap((req, res) => { const e = Number(req.query.edge); res.json(store.listRemoved(Number.isInteger(e) && e > 0 ? e : null)); }));
router.post('/removed/:key/restore', wrap((req, res) => {
  const ex = store.restoreExample(req.params.key);
  if (!ex) return res.status(404).json({ error: 'That removed example could not be found.' });
  res.json(ex);
}));
router.delete('/removed', wrap((req, res) => { const e = Number(req.query.edge); res.json({ deleted: store.destroyAllRemoved(Number.isInteger(e) && e > 0 ? e : null) }); }));
router.delete('/removed/:key', wrap((req, res) => {
  if (!store.destroyRemoved(req.params.key)) return res.status(404).json({ error: 'That removed example could not be found.' });
  res.json({ deleted: 1 });
}));
router.get('/removed/:key/image/:name', wrap((req, res) => {
  const p = store.removedImagePath(req.params.key, req.params.name);
  if (!p) return res.status(404).json({ error: 'No such picture.' });
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(p);
}));
router.delete('/examples/:id', wrap((req, res) => {
  if (!store.removeExample(Number(req.params.id))) return res.status(404).json({ error: 'That example no longer exists.' });
  res.json({ removed: true });
}));
router.get('/examples/:id/image/:name', wrap((req, res) => {
  const p = store.imagePath(req.params.id, req.params.name);
  if (!p) return res.status(404).json({ error: 'No such picture.' });
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(p);
}));

module.exports = router;
