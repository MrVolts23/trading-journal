// Quant Desk (desk/ — grinder + judge; demo-only, holdout: none yet)
export const deskGetStatus        = ()             => api.get('/desk/status').then(r => r.data);
export const deskGetRiskProfile   = ()             => api.get('/desk/risk-profile').then(r => r.data);
export const deskPutRiskProfile   = (fields)       => api.put('/desk/risk-profile', fields).then(r => r.data);
export const deskGetStrategies    = ()             => api.get('/desk/strategies').then(r => r.data);
export const deskGetExperiments   = (params)       => api.get('/desk/experiments', { params }).then(r => r.data);
export const deskCreateExperiment = (data)         => api.post('/desk/experiments', data).then(r => r.data);
// bake runs synchronously on the server (folds × experiments) — allow up to 3 minutes
export const deskBake             = (ids)          => api.post('/desk/bake', ids ? { ids } : {}, { timeout: 180000 }).then(r => r.data);
export const deskGetExperiment    = (id)           => api.get(`/desk/experiments/${id}`).then(r => r.data);
export const deskGetLeaderboard   = (window)       => api.get('/desk/leaderboard', { params: { window } }).then(r => r.data);
export const deskGetSchema        = ()             => api.get('/desk/schema').then(r => r.data);

// Quant Desk four-screen UX (Edge / Risk / Results / Activity), 2026-09-03. Owner B (EdgePage) imports these names.
export const deskGetRulesheet   = (strategyId) => api.get('/desk/rulesheet', { params: strategyId != null ? { strategy_id: strategyId } : {} }).then(r => r.data);
export const deskGetVersions    = (family)     => api.get('/desk/versions', { params: family ? { family } : {} }).then(r => r.data);
// creates the child version (if there are changes) and bakes it synchronously — allow up to 3 minutes
export const deskEdgeTest       = ({ strategy_id, changes, note }) => api.post('/desk/edge/test', { strategy_id, changes: changes || {}, note: note || '' }, { timeout: 180000 }).then(r => r.data);
export const deskGetResults     = (window)     => api.get('/desk/results', { params: { window: window === 'month' ? 'month' : 'week' } }).then(r => r.data);
export const deskGetResult      = (id)         => api.get(`/desk/results/${id}`).then(r => r.data);
export const deskGetActivity    = (limit = 50) => api.get('/desk/activity', { params: { limit } }).then(r => r.data);


// Quant Desk chat drawer ("Talk to the desk"), 2026-09-03. Owner B (DeskChat) imports these names.
// The model only proposes; a test runs only when Mike taps Apply & test (same code path as /edge/test).
export const deskChatStatus    = ()                              => api.get('/desk/chat/status').then(r => r.data);
export const deskChatThreads   = ()                              => api.get('/desk/chat/threads').then(r => r.data);
export const deskChatThread    = (id)                            => api.get(`/desk/chat/threads/${id}`).then(r => r.data);
export const deskChatNewThread = ()                              => api.post('/desk/chat/threads').then(r => r.data);
// the model call can take a while on a long thread, so allow up to 3 minutes
export const deskChatSend      = ({ thread_id, text, context })  => api.post('/desk/chat/messages', { ...(thread_id != null ? { thread_id } : {}), text, context: context || {} }, { timeout: 180000 }).then(r => r.data);
// apply = make the child version and bake it synchronously, so allow up to 3 minutes
export const deskChatApply     = (messageId, { strategy_id, note } = {}) => api.post(`/desk/chat/proposals/${messageId}/apply`, { strategy_id, ...(note ? { note } : {}) }, { timeout: 180000 }).then(r => r.data);
export const deskChatSaveKey   = (key) => api.post('/desk/chat/key', { key }).then(r => r.data);
export const deskChatRemoveKey = ()    => api.delete('/desk/chat/key').then(r => r.data);
