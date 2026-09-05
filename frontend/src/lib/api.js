import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 30000 });

// Trades
export const getTrades = (params) => api.get('/trades', { params }).then(r => r.data);
export const updateTrade = (id, data) => api.patch(`/trades/${id}`, data).then(r => r.data);
export const deleteTrade = (id) => api.delete(`/trades/${id}`).then(r => r.data);
export const exportTradesCsv = (params) => {
  const qs = new URLSearchParams(params).toString();
  window.open(`/api/trades/export/csv?${qs}`, '_blank');
};

// Dashboard
export const getDashboardStats = (params) => api.get('/dashboard/stats', { params }).then(r => r.data);
export const getPnlOverTime = (params) => api.get('/dashboard/pnl-over-time', { params }).then(r => r.data);
export const getStrategyPerformance = (params) => api.get('/dashboard/strategy-performance', { params }).then(r => r.data);
export const getMarketPerformance = (params) => api.get('/dashboard/market-performance', { params }).then(r => r.data);
export const getWinRateByDay = (params) => api.get('/dashboard/winrate-by-day', { params }).then(r => r.data);
export const getDurationDistribution = (params) => api.get('/dashboard/duration-distribution', { params }).then(r => r.data);
export const getBalanceOverTime = (params) => api.get('/dashboard/balance-over-time', { params }).then(r => r.data);
export const getPlanAdherence   = (params) => api.get('/dashboard/plan-adherence',    { params }).then(r => r.data);

// Calendar
export const getCalendar = (params) => api.get('/calendar', { params }).then(r => r.data);

// MetaDrift
export const getMetaDriftCalendar  = (params) => api.get('/metadrift/calendar', { params }).then(r => r.data);
export const saveMetaDriftEntry    = (data)   => api.post('/metadrift/entry', data).then(r => r.data);
export const deleteMetaDriftEntry  = (date, account) => api.delete(`/metadrift/entry/${date}`, { params: { account } }).then(r => r.data);

// Daily Setup (per symbol + day backtest sheet — separate from real stats)
export const getDailySetup  = (symbol, date) => api.get('/daily-setup', { params: { symbol, date } }).then(r => r.data);
export const saveDailySetup = (data)         => api.put('/daily-setup', data).then(r => r.data);
export const deleteDailySetup = (symbol, date) => api.delete('/daily-setup', { params: { symbol, date } }).then(r => r.data);

// Accounts
export const getAccounts = () => api.get('/accounts').then(r => r.data);
export const deleteAccount = (id) => api.delete(`/accounts/${id}`).then(r => r.data);
export const getAccountActivity = (params) => api.get('/accounts/activity', { params }).then(r => r.data);
export const addAccountActivity = (data) => api.post('/accounts/activity', data).then(r => r.data);
export const getSettings = () => api.get('/accounts/settings').then(r => r.data);
export const updateSettings = (data) => api.patch('/accounts/settings', data).then(r => r.data);
export const postBalanceCorrection = (accountId, data) => api.post(`/accounts/${accountId}/correction`, data).then(r => r.data);
export const getNewsEvents = (params) => api.get('/news', { params }).then(r => r.data);
export const deleteAccountActivity = (id) => api.delete(`/accounts/activity/${id}`).then(r => r.data);
export const updateAccountStartingBalance = (id, initial_deposit) => api.patch(`/accounts/${id}`, { initial_deposit }).then(r => r.data);

// Import — three-step flow: upload (multipart, direct) → preview (JSON) → commit (JSON)
export const getDefaultMapping = () => api.get('/import/mapping/default').then(r => r.data);
export const getSavedMappings  = () => api.get('/import/mapping/saved').then(r => r.data);
export const saveMapping       = (data) => api.post('/import/mapping/save', data).then(r => r.data);

// Step 1: Upload the raw file as a binary octet-stream — no multipart, no FormData,
// no multer on the backend. The filename goes in a header. This sidesteps every
// Vite-proxy / multipart-parsing issue that has plagued this route.
// Returns { uploadId, filename, size, columns, rowCount }.
export const uploadImportFile = async (file) => {
  const buffer = await file.arrayBuffer();
  const res = await fetch('/api/import/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name),
    },
    body: buffer,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(`Upload failed (HTTP ${res.status}): ${text.slice(0, 200) || '(no response)'}`); }
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
};

// Step 2: Parse the stored file with the given field mapping.
// Plain JSON — goes through the normal Vite proxy.
export const previewImport = (uploadId, mapping, importFromDate, account) =>
  api.post('/import/preview', {
    uploadId,
    mapping,
    ...(importFromDate ? { importFromDate } : {}),
    ...(account        ? { account }        : {}),
  }).then(r => r.data);

// Resolve a broker login ID to an account name (auto-creates the account if needed)
export const resolveAccountByLogin = (loginId, broker) =>
  api.post('/accounts/resolve', { loginId, broker }).then(r => r.data);

// Delete all trades for a specific account (used to manage bad imports)
export const clearTradesByAccount = (account) =>
  api.delete(`/trades/clear-account/${encodeURIComponent(account)}`).then(r => r.data);

// Step 3: Commit the rows that were cached during preview.
// Plain JSON — no large payload, just the uploadId.
export const commitImport = (uploadId) =>
  api.post('/import/commit', { uploadId }).then(r => r.data);

// Withdrawal Plan
export const getWithdrawalPlanSettings = () => api.get('/withdrawal-plan/settings').then(r => r.data);
export const saveWithdrawalPlanSettings = (data) => api.put('/withdrawal-plan/settings', data).then(r => r.data);
export const getWithdrawalPlanActuals = () => api.get('/withdrawal-plan/actuals').then(r => r.data);
export const saveWithdrawalActual = (weekNum, data) => api.put(`/withdrawal-plan/actuals/${weekNum}`, data).then(r => r.data);
export const getWeeklyPnl = () => api.get('/withdrawal-plan/weekly-pnl').then(r => r.data);
export const getStartingBalance = (startDate) => api.get(`/withdrawal-plan/starting-balance${startDate ? `?startDate=${startDate}` : ''}`).then(r => r.data);

// Trade Journal
export const getJournalTrades    = (params)       => api.get('/journal', { params }).then(r => r.data);
export const getJournalTrade     = (id)            => api.get(`/journal/${id}`).then(r => r.data);
export const saveJournalTrade    = (id, data)      => api.put(`/journal/${id}`, data).then(r => r.data);
export const toggleTradeReviewed = (id, reviewed)  => api.patch(`/journal/${id}/reviewed`, { reviewed }).then(r => r.data);

// Key Setups
export const getKeySetups    = ()           => api.get('/key-setups').then(r => r.data);
export const createKeySetup  = (data)       => api.post('/key-setups', data).then(r => r.data);
export const updateKeySetup  = (id, data)   => api.put(`/key-setups/${id}`, data).then(r => r.data);
export const deleteKeySetup  = (id)         => api.delete(`/key-setups/${id}`).then(r => r.data);
export const importKeySetups = (setups)     => api.post('/key-setups/import', { setups }).then(r => r.data);

// Key Lessons
export const getKeyLessons        = ()           => api.get('/key-lessons').then(r => r.data);
export const getKeyLessonsAnalytics = ()         => api.get('/key-lessons/analytics').then(r => r.data);
export const createKeyLesson      = (data)       => api.post('/key-lessons', data).then(r => r.data);
export const updateKeyLesson      = (id, data)   => api.put(`/key-lessons/${id}`, data).then(r => r.data);
export const deleteKeyLesson      = (id)         => api.delete(`/key-lessons/${id}`).then(r => r.data);

// Mistake Types (managed in Settings)
export const getMistakeTypes    = ()         => api.get('/mistake-types').then(r => r.data);
export const createMistakeType  = (data)     => api.post('/mistake-types', data).then(r => r.data);
export const updateMistakeType  = (id, data) => api.put(`/mistake-types/${id}`, data).then(r => r.data);
export const deleteMistakeType  = (id)       => api.delete(`/mistake-types/${id}`).then(r => r.data);

// Gold Metal Alchemist
export const gmaGetStatus       = ()          => api.get('/gma/status').then(r => r.data);
export const gmaGetDays         = (params)    => api.get('/gma/days', { params }).then(r => r.data);
export const gmaGetDay          = (id)        => api.get(`/gma/days/${id}`).then(r => r.data);
export const gmaPostVerdict     = (dayId, data) => api.post(`/gma/days/${dayId}/verdict`, data).then(r => r.data);
export const gmaUndoVerdict     = (dayId)       => api.delete(`/gma/days/${dayId}/verdict`).then(r => r.data);
export const gmaPeek            = (dayId)       => api.post(`/gma/days/${dayId}/peek`).then(r => r.data);
export const gmaGetAgreement    = ()          => api.get('/gma/agreement').then(r => r.data);
export const gmaGetVentures     = ()          => api.get('/gma/ventures').then(r => r.data);
export const gmaCreateVenture   = (data)      => api.post('/gma/ventures', data).then(r => r.data);
export const gmaGetExperiments  = (ventureId) => api.get(`/gma/ventures/${ventureId}/experiments`).then(r => r.data);
export const gmaGetRuns         = ()          => api.get('/gma/runs').then(r => r.data);
export const gmaGetEscalations  = ()          => api.get('/gma/escalations').then(r => r.data);
export const gmaPatchEscalation = (id, status) => api.patch(`/gma/escalations/${id}`, { status }).then(r => r.data);
export const gmaGetRecon        = ()          => api.get('/gma/recon').then(r => r.data);
export const gmaCalendarImport  = (selections) => api.post('/gma/calendar-import', { selections }).then(r => r.data);
export const gmaIngestRun       = ()          => api.post('/gma/ingest/run').then(r => r.data);
export const gmaGetStrategies   = ()          => api.get('/gma/strategies').then(r => r.data);
export const gmaGetStrategy     = (id)        => api.get(`/gma/strategies/${id}`).then(r => r.data);
export const gmaPatchStrategy   = (id, data)  => api.patch(`/gma/strategies/${id}`, data).then(r => r.data);
export const gmaAddExample      = (id, data)  => api.post(`/gma/strategies/${id}/examples`, data).then(r => r.data);
export const gmaDeleteExample   = (id)        => api.delete(`/gma/examples/${id}`).then(r => r.data);

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

export default api;

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
