// Shared store for FTMO prop accounts tracked on the Prop Management page.
// Lives in localStorage so the tracker works mid-session without the backend.
// Settings and Prop Management both create accounts through here so the two stay in step.

export const PROP_LS_KEY = 'prop_accounts_v1';
export const PROP_RISK_LS_KEY = 'prop_risk_v1';

export function loadLS(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
export function saveLS(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

export function loadPropStore() { return loadLS(PROP_LS_KEY, { accounts: [], activeId: null }); }
export function savePropStore(store) { saveLS(PROP_LS_KEY, store); }

// Append a tracker account and make it the active one.
export function addPropAccount(acct) {
  const s = loadPropStore();
  const store = { accounts: [...s.accounts, acct], activeId: acct.id };
  savePropStore(store);
  return store;
}

// Remove the tracker account tied to a journal account (used when the journal account is deleted in Settings).
export function removePropAccountByJournalId(journalAccountId) {
  const s = loadPropStore();
  const accounts = s.accounts.filter((a) => a.journalAccountId !== journalAccountId);
  if (accounts.length === s.accounts.length) return s;
  const store = { accounts, activeId: accounts.some((a) => a.id === s.activeId) ? s.activeId : (accounts[0]?.id || null) };
  savePropStore(store);
  return store;
}

export function findPropAccountByJournalId(journalAccountId) {
  return loadPropStore().accounts.find((a) => a.journalAccountId === journalAccountId) || null;
}

// ── Fill the tracker from the journal ─────────────────────────────────────────
// FTMO's MT5 server runs on Prague time, so the date part of exit_datetime is the Prague day.
// Each day's trades become the closed results for that day; worst dips already typed in are kept.
// Days before the current phase's start date belong to earlier phases and stay in the journal only.
export function rebuildPropDaysFromTrades(acct, trades, todayKey) {
  const byDay = {};
  for (const t of trades) {
    const dt = t.exit_datetime || t.entry_datetime;
    if (!dt) continue;
    const day = String(dt).slice(0, 10);
    if (acct.startDate && day < acct.startDate) continue;
    const net = (Number(t.pnl) || 0) + (Number(t.commission) || 0);
    (byDay[day] ||= []).push(Math.round(net * 100) / 100);
  }
  const prevDip = (d) => (acct.days || []).find((x) => x.date === d)?.worstDip || 0;
  const days = Object.keys(byDay).filter((d) => d < todayKey).sort().map((d) => ({ date: d, trades: byDay[d], worstDip: prevDip(d), fromJournal: true }));
  const todayDip = acct.today?.date === todayKey ? (acct.today.worstDip || 0) : 0;
  const today = byDay[todayKey]
    ? { date: todayKey, trades: byDay[todayKey], worstDip: todayDip, fromJournal: true }
    : (acct.today?.date === todayKey ? acct.today : { date: todayKey, trades: [], worstDip: 0 });
  return { ...acct, days, today, lastJournalSync: new Date().toISOString(), journalTradeCount: trades.length };
}

// Pull every trade for the linked journal account and rebuild the tracker's day log from it.
// Returns { synced: n, days: m } or null when the tracker account is not linked.
export async function syncPropAccountFromJournal(propAccountId, todayKey) {
  const { getTrades } = await import('./api');
  const s = loadPropStore();
  const acct = s.accounts.find((a) => a.id === propAccountId);
  if (!acct || !acct.journalAccountName) return null;
  const res = await getTrades({ account: acct.journalAccountName, limit: 10000, sort: 'exit_datetime', dir: 'ASC' });
  const trades = Array.isArray(res) ? res : (res.trades || res.data || []);
  const next = rebuildPropDaysFromTrades(acct, trades, todayKey);
  savePropStore({ ...s, accounts: s.accounts.map((a) => (a.id === propAccountId ? next : a)) });
  return { synced: trades.length, days: next.days.length + (next.today.trades.length ? 1 : 0), acct: next };
}

// Which tracker accounts are tied to any of these journal account names.
export function propAccountsForJournalNames(names) {
  const set = new Set(names || []);
  return loadPropStore().accounts.filter((a) => a.journalAccountName && set.has(a.journalAccountName));
}
