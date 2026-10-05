import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, X, Mic, Send, Loader2, MoreVertical, Copy, Check, RefreshCw, Plus } from 'lucide-react';
import { deskChatStatus, deskChatThreads, deskChatThread, deskChatSend, deskChatApply, deskChatNewThread, deskGetRulesheet, deskChatSaveKey } from '../../lib/api';
import useSpeech from './useSpeech';

// ─────────────────────────────────────────────────────────────────────────────
// Talk to the desk: a right-side drawer mounted on every /desk page.
// Mike says what he wants; the desk answers in plain sentences and, when it can, shows a
// proposal card: one sentence per change, a confidence chip, anything that needs engine work.
// "Apply & test" runs the same test as the Edge page. The model never writes anything itself.
// No raw parameter keys are ever shown: every change renders from the server's changes_text.
// ─────────────────────────────────────────────────────────────────────────────

const LS_OPEN = 'deskChat.open';
const LS_THREAD = 'deskChat.threadId';
const EMPTY_TEXT = "Tell me what you want to change. For example: 'try a wider stop padding' or 'only take the second entry after a sweep'.";
const ADD_KEY_DEFAULT = 'security add-generic-password -s quant-desk -a anthropic -w';

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch { /* private mode */ } };
const J = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };
const usd = (v) => (v == null || Number.isNaN(Number(v)) ? '$0.00' : '$' + Number(v).toFixed(2));
const capUsd = (v) => (v == null ? '$10' : Number(v) % 1 === 0 ? '$' + Number(v).toFixed(0) : '$' + Number(v).toFixed(2));

function fmtWhen(t) {
  if (t == null || t === '') return '';
  let d;
  if (typeof t === 'number') d = new Date(t < 1e11 ? t * 1000 : t);
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(String(t))) d = new Date(String(t).replace(' ', 'T') + 'Z');
  else d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// The verifier says PASS / REJECT / BLOCKED / ERROR. Mike reads PASS / FAIL.
function verdictWord(v) {
  if (!v) return null;
  const s = String(v).toUpperCase();
  if (s === 'PASS') return 'PASS';
  if (s === 'BLOCKED') return 'BLOCKED';
  if (s === 'ERROR' || s === 'FAILED') return 'ERROR';
  return 'FAIL';
}
function VerdictBadge({ v }) {
  const w = verdictWord(v);
  const cls = w === 'PASS' ? 'text-green-400 border-green-600/50 bg-green-500/5' : w === 'FAIL' ? 'text-red-400 border-red-600/50 bg-red-500/5'
    : w === 'BLOCKED' ? 'text-amber-400 border-amber-600/50 bg-amber-500/5' : 'text-terminal-dim border-terminal-border';
  return <span className={`inline-block rounded border font-mono font-semibold uppercase tracking-wide px-2 py-0.5 text-[11px] ${cls}`}>{w || 'not tested'}</span>;
}

// A stored message may carry the model's whole JSON ({reply, proposal, new_rules, questions}) or
// just the inner proposal ({changes, summary, confidence}). Normalise to one shape.
function unpack(m) {
  const raw = J(m?.proposal);
  const outer = raw && typeof raw === 'object' && ('proposal' in raw || 'new_rules' in raw || 'questions' in raw) && !('changes' in raw) ? raw : null;
  const inner = outer ? outer.proposal : raw && typeof raw === 'object' && 'changes' in raw ? raw : null;
  const changesText = J(m?.changes_text) ?? (Array.isArray(m?.changes_text) ? m.changes_text : null);
  const sentences = Array.isArray(changesText) ? changesText.filter((s) => typeof s === 'string' && s.trim()) : (typeof changesText === 'string' && changesText.trim() ? changesText.split(/\n+/).filter(Boolean) : []);
  const newRules = (outer?.new_rules ?? m?.new_rules ?? inner?.new_rules ?? []) || [];
  const questions = (outer?.questions ?? m?.questions ?? inner?.questions ?? []) || [];
  const hasChanges = !!(inner && inner.changes && typeof inner.changes === 'object' && Object.keys(inner.changes).length);
  return {
    proposal: inner && (hasChanges || inner.summary) ? inner : null,
    sentences,
    hasChanges,
    newRules: Array.isArray(newRules) ? newRules : [],
    questions: Array.isArray(questions) ? questions : [],
    applied: !!(m?.applied_experiment_id || m?.applied || inner?.applied || (raw && raw.applied)),
  };
}

function ConfidenceChip({ c }) {
  const v = String(c || '').toLowerCase();
  if (!v) return null;
  const cls = v === 'sure' ? 'text-green-400 border-green-600/40' : v === 'likely' ? 'text-amber-400 border-amber-600/40' : 'text-terminal-muted border-terminal-border';
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide ${cls}`}>{v}</span>;
}

function CopyBox({ text }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked; the text is selectable */ }
  };
  return (
    <div className="flex items-stretch gap-1">
      <code className="flex-1 min-w-0 block bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 text-[11px] font-mono text-terminal-text break-all select-all">{text}</code>
      <button type="button" onClick={copy} title="Copy" className="px-2 rounded border border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-dim">
        {done ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

// Card under an assistant reply: the proposal as sentences, plus Apply & test / Not now.
function ProposalCard({ m, info, onApply, onDismiss, applying, canApply, dismissed }) {
  const { proposal, sentences, hasChanges, newRules, questions, applied } = info;
  const showCard = proposal || newRules.length || questions.length;
  if (!showCard) return null;
  const busy = applying === m.id;
  const canApplyHere = canApply || proposal?.strategy_id != null;
  return (
    <div className="mt-2 rounded-lg border border-terminal-border bg-terminal-bg/60 px-3 py-2.5 space-y-2.5">
      {proposal && (
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-sans text-terminal-text leading-snug">{proposal.summary || 'Proposed change'}</div>
            <ConfidenceChip c={proposal.confidence} />
          </div>
          {sentences.length > 0 && (
            <ul className="space-y-1">
              {sentences.map((s, i) => <li key={i} className="text-[13px] font-sans text-terminal-text/90 leading-snug pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.55em] before:w-1 before:h-1 before:rounded-full before:bg-terminal-amber/80">{s}</li>)}
            </ul>
          )}
          {hasChanges && !sentences.length && <div className="text-xs font-mono text-terminal-muted">One or more rule changes. The Edge page shows the exact sentences after testing.</div>}
        </div>
      )}
      {newRules.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-mono uppercase tracking-wider text-terminal-dim">Needs engine work</div>
          <ul className="space-y-1">
            {newRules.map((r, i) => (
              <li key={i} className="text-[13px] font-sans text-terminal-text/90 leading-snug pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.55em] before:w-1 before:h-1 before:rounded-full before:bg-terminal-dim">
                {typeof r === 'string' ? r : r?.text}
                {r?.why_engine_work && <span className="block text-[11px] font-mono text-terminal-muted mt-0.5">{r.why_engine_work}</span>}
              </li>
            ))}
          </ul>
          <div className="text-[11px] font-mono text-terminal-dim">The engine cannot run this yet. It is logged as a request; nothing here gets tested.</div>
        </div>
      )}
      {questions.length > 0 && (
        <ul className="space-y-1">
          {questions.map((q, i) => <li key={i} className="text-[13px] font-sans text-terminal-text leading-snug pl-3 relative before:content-['?'] before:absolute before:left-0 before:top-0 before:text-terminal-amber before:text-xs">{q}</li>)}
        </ul>
      )}
      {proposal && hasChanges && (
        <div className="flex items-center gap-2 flex-wrap pt-0.5">
          {applied ? (
            <span className="text-[11px] font-mono text-terminal-dim">Applied and tested.</span>
          ) : dismissed ? (
            <span className="text-[11px] font-mono text-terminal-dim">Set aside.</span>
          ) : (
            <>
              <button type="button" onClick={() => onApply(m)} disabled={busy || !!applying || !canApplyHere}
                title={canApplyHere ? '' : 'Pick a version on the Edge page first'}
                className={`px-3 py-1.5 rounded border text-xs font-mono ${!busy && !applying && canApplyHere ? 'bg-terminal-amber text-black border-terminal-amber font-semibold' : 'text-terminal-dim border-terminal-border cursor-not-allowed'}`}>
                {busy ? <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Testing... about 10 seconds</span> : 'Apply & test'}
              </button>
              {!busy && <button type="button" onClick={() => onDismiss(m)} className="px-3 py-1.5 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim">Not now</button>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The assistant message that comes back from an apply: verdict badge + reason + two links.
function ResultStrip({ m }) {
  const r = m.result || {};
  const verdict = r.verdict || m.verdict || (/\bPASS\b/.test(String(m.text || '')) ? 'PASS' : /\bFAIL\b/.test(String(m.text || '')) ? 'REJECT' : null);
  const expId = r.experiment_id ?? m.applied_experiment_id ?? m.experiment_id ?? null;
  const stratId = r.strategy_id ?? m.strategy_id ?? m.applied_strategy_id ?? null;
  if (!verdict && expId == null) return null;
  return (
    <div className="mt-2 flex items-center gap-2 flex-wrap">
      {verdict && <VerdictBadge v={verdict} />}
      {expId != null && <Link to={`/desk/results?open=${expId}`} className="text-[11px] font-mono text-terminal-amber hover:underline">See in Results</Link>}
      {stratId != null && <Link to={`/desk/edge?version=${stratId}`} className="text-[11px] font-mono text-terminal-amber hover:underline">Open in Edge</Link>}
    </div>
  );
}

function Message({ m, applying, onApply, onDismiss, canApply, dismissed }) {
  const mine = m.role === 'user';
  const sys = m.role === 'system' || m.role === 'error';
  const info = useMemo(() => unpack(m), [m]);
  const isResult = !mine && (m.result || m.applied_experiment_id != null) && !info.hasChanges;
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[88%] ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`rounded-lg px-3 py-2 text-sm font-sans leading-relaxed whitespace-pre-wrap break-words ${
          mine ? 'bg-terminal-amber/15 border border-terminal-amber/30 text-terminal-text'
          : sys ? 'border border-terminal-red/40 text-red-400 text-xs font-mono'
          : 'bg-terminal-surface border border-terminal-border text-terminal-text'}`}>
          {m.text}
          {!mine && !sys && isResult && <ResultStrip m={m} />}
        </div>
        {!mine && !sys && <ProposalCard m={m} info={info} onApply={onApply} onDismiss={onDismiss} applying={applying} canApply={canApply} dismissed={dismissed} />}
        {m.created_at && <span className="mt-0.5 text-[10px] font-mono text-terminal-dim">{fmtWhen(m.created_at)}</span>}
      </div>
    </div>
  );
}

export default function DeskChat() {
  const location = useLocation();
  const [open, setOpen] = useState(() => lsGet(LS_OPEN) === '1');
  const [threadId, setThreadId] = useState(() => { const v = lsGet(LS_THREAD); return v ? Number(v) : null; });
  const [threads, setThreads] = useState([]);
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(null);
  const [unread, setUnread] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => new Set());
  const [defaultStrategyId, setDefaultStrategyId] = useState(null);
  const [keyInput, setKeyInput] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState(null);
  const [showTerminalWay, setShowTerminalWay] = useState(false);
  const saveKey = async () => {
    const k = keyInput.trim();
    if (!k) { setKeyError('Paste the key first.'); return; }
    setKeySaving(true); setKeyError(null);
    try {
      const r = await deskChatSaveKey(k);
      setKeyInput('');
      if (r?.status) setStatus((s) => ({ ...(s || {}), ...r.status }));
    } catch (e) {
      setKeyError(e?.response?.data?.error || e.message || 'Could not save the key.');
    } finally { setKeySaving(false); }
  };
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  // Which version the chat should change: the one on the Edge page's URL, else the newest.
  const urlVersion = useMemo(() => {
    if (!location.pathname.startsWith('/desk/edge')) return null;
    const v = new URLSearchParams(location.search).get('version');
    return v ? Number(v) : null;
  }, [location.pathname, location.search]);
  const strategyId = urlVersion ?? defaultStrategyId;

  const loadStatus = useCallback(async () => {
    try { const s = await deskChatStatus(); setStatus(s); setStatusError(null); return s; }
    catch (e) { setStatusError(e?.response?.data?.error || (e?.code === 'ECONNABORTED' ? 'the desk is not answering' : e?.response?.status === 404 ? 'the desk has no chat yet' : e.message) || 'could not reach the desk'); return null; }
  }, []);
  const loadThreads = useCallback(async () => {
    try { const t = await deskChatThreads(); const list = Array.isArray(t) ? t : t?.threads || []; setThreads(list); return list; } catch { return []; }
  }, []);
  const loadThread = useCallback(async (id) => {
    if (id == null) { setMessages([]); return; }
    try {
      const t = await deskChatThread(id);
      setMessages(Array.isArray(t?.messages) ? t.messages : []);
      if (t?.thread?.id != null) { setThreadId(Number(t.thread.id)); lsSet(LS_THREAD, t.thread.id); }
    } catch (e) {
      if (e?.response?.status === 404) { setThreadId(null); lsSet(LS_THREAD, null); setMessages([]); }
    }
  }, []);

  // On open: status, threads, and the saved thread (or the newest one).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      await loadStatus();
      const list = await loadThreads();
      if (!alive) return;
      const want = threadId ?? (list[0] ? Number(list[0].id) : null);
      if (want != null) await loadThread(want);
      else setMessages([]);
      setUnread(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Default version for the context, fetched once (quietly fails when there are no versions yet).
  useEffect(() => {
    if (!open || defaultStrategyId != null) return;
    deskGetRulesheet().then((s) => { if (s?.strategy?.id != null) setDefaultStrategyId(Number(s.strategy.id)); }).catch(() => {});
  }, [open, defaultStrategyId]);

  useEffect(() => { lsSet(LS_OPEN, open ? '1' : '0'); }, [open]);
  useEffect(() => { if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [messages, open, sending, applying]);

  const appendTranscript = useCallback((t) => { setText((cur) => (cur.trim() ? cur.replace(/\s+$/, '') + ' ' + t : t)); inputRef.current?.focus(); }, []);
  const speech = useSpeech({ onFinal: appendTranscript });

  const canChat = status ? status.can_chat !== false && status.key !== 'absent' : true;
  const keyAbsent = status?.key === 'absent';
  const addKeyCmd = status?.add_key_command || ADD_KEY_DEFAULT;

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setText('');
    const local = { id: `local-${Date.now()}`, role: 'user', text: body, created_at: Date.now() };
    setMessages((ms) => [...ms, local]);
    setSending(true);
    try {
      const r = await deskChatSend({ thread_id: threadId ?? undefined, text: body, context: { strategy_id: strategyId ?? undefined, page: location.pathname } });
      if (r?.thread_id != null && Number(r.thread_id) !== threadId) { setThreadId(Number(r.thread_id)); lsSet(LS_THREAD, r.thread_id); loadThreads(); }
      const reply = r?.message ? [r.message] : [];
      setMessages((ms) => [...ms, ...reply]);
      // The backend returns budget on every send and, on the no-model paths (key absent, over cap,
      // provider error), a full status object under r.status. Merge both into the header state.
      const st = r?.status && typeof r.status === 'object' ? r.status : (r?.key ? { key: r.key, can_chat: r.can_chat, reason: r.reason, add_key_command: r.add_key_command } : null);
      if (r?.budget || st) setStatus((s) => ({ ...(s || {}), ...(r.budget || {}), ...(st || {}), add_key_command: st?.add_key_command || s?.add_key_command }));
      else loadStatus();
      if (!openRef.current) setUnread(true);
    } catch (e) {
      const d = e?.response?.data;
      const why = d?.error || (Array.isArray(d?.errors) ? d.errors.join(' ') : null) || (e?.code === 'ECONNABORTED' ? 'the desk took too long to answer' : e.message) || 'the desk did not answer';
      setMessages((ms) => [...ms, { id: `err-${Date.now()}`, role: 'error', text: why }]);
    } finally { setSending(false); }
  };

  const apply = async (m) => {
    if (applying) return;
    // The proposal's sentences were written against the version the desk saw when it answered, so
    // apply to that version; fall back to the drawer's current version for older messages.
    const proposalSid = J(m?.proposal)?.strategy_id;
    const sid = proposalSid ?? strategyId;
    if (sid == null) { setMessages((ms) => [...ms, { id: `err-${Date.now()}`, role: 'error', text: 'Pick a version on the Edge page first, then apply.' }]); return; }
    setApplying(m.id);
    try {
      const r = await deskChatApply(m.id, { strategy_id: Number(sid) });
      const applied = r?.experiment_id ?? r?.message?.applied_experiment_id ?? null;
      const stratId = r?.strategy?.id ?? null;
      // keep everything the backend already put on message.result (verdict_word, version, changes_text) and
      // fill in the top-level fields so the badge and links render even for a bare /edge/test shape
      const result = { ...(r?.message?.result || {}), verdict: r?.verdict ?? r?.message?.result?.verdict, reason: r?.reason ?? r?.message?.result?.reason, experiment_id: applied, strategy_id: stratId ?? r?.message?.result?.strategy_id ?? null };
      const newMsg = r?.message
        ? { ...r.message, result }
        : { id: `apply-${Date.now()}`, role: 'assistant', text: `Tested as ${r?.strategy?.version || 'a new version'}: ${verdictWord(r?.verdict) || 'done'}.${r?.reason ? ' ' + r.reason : ''}`, applied_experiment_id: applied, created_at: Date.now(), result };
      setMessages((ms) => [...ms.map((x) => (x.id === m.id ? { ...x, applied_experiment_id: applied ?? x.applied_experiment_id ?? true } : x)), newMsg]);
      loadStatus();
      if (!openRef.current) setUnread(true);
    } catch (e) {
      const d = e?.response?.data;
      const why = d?.error || (Array.isArray(d?.errors) ? d.errors.join(' ') : null) || (e?.code === 'ECONNABORTED' ? 'the test took too long' : e.message) || 'the test did not run';
      setMessages((ms) => [...ms, { id: `err-${Date.now()}`, role: 'error', text: why }]);
    } finally { setApplying(null); }
  };

  const dismiss = (m) => setDismissed((s) => { const n = new Set(s); n.add(m.id); return n; });

  const newThread = async () => {
    setMenuOpen(false);
    try {
      const t = await deskChatNewThread();
      const id = t?.id ?? t?.thread?.id ?? null;
      setThreadId(id != null ? Number(id) : null); lsSet(LS_THREAD, id);
      setMessages([]);
      loadThreads();
    } catch (e) {
      setMessages((ms) => [...ms, { id: `err-${Date.now()}`, role: 'error', text: e?.response?.data?.error || e.message || 'could not start a conversation' }]);
    }
    inputRef.current?.focus();
  };
  const pickThread = async (id) => { setMenuOpen(false); await loadThread(Number(id)); };

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  // Collapsed: a pill at bottom-right. A small dot means a reply arrived while it was closed.
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-20 inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-terminal-surface border border-terminal-border shadow-lg text-sm font-mono text-terminal-text hover:border-terminal-amber/60 transition-colors">
        <MessageSquare className="w-4 h-4 text-amber-400" />
        Talk to the desk
        {unread && <span className="w-2 h-2 rounded-full bg-terminal-amber" aria-label="new reply" />}
      </button>
    );
  }

  const spent = status?.spent_today_usd;
  const cap = status?.cap_usd;
  const warn = status?.warn_at_usd != null && spent != null && Number(spent) >= Number(status.warn_at_usd);

  return (
    <aside className="w-[420px] flex-shrink-0 h-full flex flex-col bg-terminal-surface border-l border-terminal-border">
      {/* Header */}
      <div className="px-4 py-3 border-b border-terminal-border flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-mono text-terminal-text">Talk to the desk</h2>
          </div>
          <div className="mt-0.5 text-[11px] font-mono text-terminal-muted truncate">
            {statusError ? <span className="text-red-400">{statusError}</span>
              : !status ? 'Checking the desk'
              : keyAbsent ? 'No API key yet'
              : <span className={warn ? 'text-amber-400' : ''}>{usd(spent)} of {capUsd(cap)} today{status.can_chat === false && status.reason ? `. ${status.reason}` : ''}</span>}
          </div>
        </div>
        <div className="relative">
          <button type="button" onClick={() => setMenuOpen((v) => !v)} title="Menu" className="p-1.5 rounded text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover">
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-1 w-56 rounded border border-terminal-border bg-terminal-bg shadow-lg z-10 py-1">
              <button type="button" onClick={newThread} className="w-full text-left px-3 py-2 text-xs font-mono text-terminal-text hover:bg-terminal-hover inline-flex items-center gap-2"><Plus className="w-3.5 h-3.5" />New conversation</button>
              {threads.length > 0 && <div className="border-t border-terminal-border my-1" />}
              {threads.slice(0, 8).map((t) => (
                <button key={t.id} type="button" onClick={() => pickThread(t.id)}
                  className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-terminal-hover truncate ${Number(t.id) === threadId ? 'text-terminal-amber' : 'text-terminal-muted'}`}>
                  {t.title || `Conversation ${t.id}`}{t.messages ? <span className="text-terminal-dim"> · {t.messages}</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" onClick={() => setOpen(false)} title="Close" className="p-1.5 rounded text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Key missing */}
      {keyAbsent && (
        <div className="mx-4 mt-3 rounded-lg border border-terminal-amber/40 bg-terminal-amber/5 px-3 py-2.5 space-y-2">
          <div className="text-xs font-sans text-terminal-text">Paste your Anthropic API key once. It goes straight into your Mac's keychain and is never shown again.</div>
          <div className="flex items-center gap-2">
            <input type="password" value={keyInput} onChange={(e) => { setKeyInput(e.target.value); setKeyError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveKey(); } }}
              placeholder="sk-ant-..." autoComplete="off" spellCheck={false}
              className="flex-1 min-w-0 bg-terminal-bg border border-terminal-border rounded px-2 py-1.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dim focus:outline-none focus:border-terminal-amber" />
            <button type="button" onClick={saveKey} disabled={keySaving || !keyInput.trim()}
              className={`px-3 py-1.5 rounded border text-xs font-mono ${keyInput.trim() && !keySaving ? 'bg-terminal-amber text-black border-terminal-amber font-semibold' : 'text-terminal-dim border-terminal-border cursor-not-allowed'}`}>
              {keySaving ? 'Saving...' : 'Save key'}
            </button>
          </div>
          {keyError && <div className="text-[11px] font-mono text-red-400">{keyError}</div>}
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => setShowTerminalWay((v) => !v)} className="text-[11px] font-mono text-terminal-dim hover:text-terminal-muted">
              {showTerminalWay ? 'Hide the Terminal way' : 'Prefer Terminal?'}
            </button>
            <button type="button" onClick={loadStatus} className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-terminal-border text-xs font-mono text-terminal-muted hover:text-terminal-text hover:border-terminal-dim"><RefreshCw className="w-3 h-3" />Retry</button>
          </div>
          {showTerminalWay && <CopyBox text={addKeyCmd} />}
        </div>
      )}

      {/* Messages */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && !sending && (
          <div className="text-sm font-sans text-terminal-muted leading-relaxed">{EMPTY_TEXT}</div>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} applying={applying} onApply={apply} onDismiss={dismiss} canApply={strategyId != null} dismissed={dismissed.has(m.id)} />
        ))}
        {sending && (
          <div className="flex justify-start"><div className="rounded-lg px-3 py-2 bg-terminal-surface border border-terminal-border text-xs font-mono text-terminal-dim inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Thinking</div></div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-terminal-border px-3 py-3 space-y-1.5">
        {speech.listening && <div className="text-[11px] font-mono text-terminal-amber">Listening{speech.interim ? `: ${speech.interim}` : '...'}</div>}
        {speech.error && <div className="text-[11px] font-mono text-red-400">{speech.error}</div>}
        <div className="flex items-end gap-2">
          <textarea ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={2}
            placeholder={keyAbsent ? 'Add the key first' : 'What do you want to change?'} disabled={sending}
            className="flex-1 min-w-0 resize-none bg-terminal-bg border border-terminal-border rounded px-3 py-2 text-sm font-sans text-terminal-text placeholder:text-terminal-dim focus:outline-none focus:border-terminal-amber disabled:opacity-60" />
          {speech.supported && (
            <button type="button" title="Hold to talk"
              onMouseDown={(e) => { e.preventDefault(); speech.start(); }} onMouseUp={speech.stop} onMouseLeave={() => { if (speech.listening) speech.stop(); }}
              onTouchStart={(e) => { e.preventDefault(); speech.start(); }} onTouchEnd={speech.stop}
              className={`p-2.5 rounded border transition-colors ${speech.listening ? 'border-terminal-amber text-terminal-amber bg-terminal-amber/10' : 'border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-dim'}`}>
              <Mic className="w-4 h-4" />
            </button>
          )}
          <button type="button" onClick={send} disabled={sending || !text.trim()} title="Send (Enter)"
            className={`p-2.5 rounded border ${!sending && text.trim() ? 'bg-terminal-amber text-black border-terminal-amber' : 'text-terminal-dim border-terminal-border cursor-not-allowed'}`}>
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        <div className="text-[10px] font-mono text-terminal-dim">
          {!canChat && status?.reason && !keyAbsent ? status.reason : 'Enter sends. Shift+Enter for a new line. Nothing runs until you tap Apply & test.'}
        </div>
      </div>
    </aside>
  );
}
