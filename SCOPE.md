# Gold Metal Alchemist — Project Scope

**One sentence:** Turn the Trading Journal app into an AI-native trading desk with a
self-learning research loop trading demo accounts through GoldBridge, full auto-journaling
with visual proof, and the Alchemy Lab — a fractal pattern-research engine built around
Mike's orientation-code discovery.

Scoped 2026-07-04. Decisions locked with Mike; do not re-litigate without him.

---

## Locked decisions

| # | Decision |
|---|----------|
| 1 | Desk lives **inside the Trading Journal app** (this repo) — shared DB, ships via release.sh, never ship blind |
| 2 | **Alchemy builds first**, integrated into the learning loop; Minara-style strategy desk follows |
| 3 | Token budget: **$10/day hard cap with auto-pause** (Claude budget shared with Hermes) |
| 4 | **Demo trading only** until Mike throws the live switch himself |
| 5 | Every strategy lifecycle promotion is a **human-gate button**, never automatic |
| 6 | The loop may **never edit** GoldBridge risk/sizing config — propose only |
| 7 | Name: **Gold Metal Alchemist** |
| 8 | Existing AlchemyPage + AlchemyCalendarPage stay untouched; new pages built alongside; calendar localStorage **copied** (not moved) into DB |
| 9 | Trade cards: **1-min + 3-min + 15-min screenshots** with entry/SL/exit lines drawn on chart |
| 10 | Sweep engine = **Cake Ventures**: Venture 1 precoded (1m 3–4pm key vs 4pm–2pm print); additional ventures user-definable on any timeframe pairing |
| 11 | **DATA SOURCE POLICY (hard rule): MT5 is the ONLY market-data source.** All bars via GMAExporter history requests; all chart images self-rendered from MT5 data. Never pull chart data or images from TradingView — same feed as the fills, one source of truth. (TV proved it: 300-bar cap + broken scroll vs MT5's on-demand dumps.) |

## Existing assets we build on

- **This app** — Electron + Express + better-sqlite3 backend, React/Vite/Tailwind/Recharts frontend.
- **GoldBridge** (`~/Projects/goldbridge`) — TV→demo-MT5 pipeline. Safety rails already in config:
  demo-only, `require_sl`, 20 orders/day, hard lot cap, `HALT` kill-switch file. EA file channel at
  `.../MetaTrader 5/MQL5/Files/goldbridge/` (in/ and out/).
- **GMAExporter EA** (in MT5) — the SOLE market-data source per decision #11: account snapshots,
  deals, and on-demand bulk history dumps through the goldbridge in/out channel. Strategy
  backtesting (Phase 3) runs on a local engine over this same data. TradingView is not used.
- **Claude Code** — scheduled headless runs are the loop engine, per the loop-engineering playbook
  (github.com/cobusgreyling/loop-engineering): state files, maker/checker, L1 report-only → L2
  assisted, hard caps, human escalation. **Never L3 on anything touching capital.**

---

## The Alchemy hypothesis (Mike's model — the core IP)

Gold's **1-min chart during 3:00–4:00pm PST** (first hour of the Globex session) prints an
approximate miniature of how the **entire trading day (4:00pm → 2:00pm PST next day)** will play
out on the ~15-min chart — in one of four orientations:

| Code | Meaning |
|------|---------|
| none | day prints the key hour as-is |
| flipH | time-reversed |
| flipV | price-inverted |
| both | 180° (time-reversed + price-inverted) |

The orientation is "the code for the day's print." Current manual workflow (screenshot → flip →
eyeball vs 15-min → log in Alchemy Calendar) works but: live orientation detection is hard,
amplitude ("how far will it go") is untested because candle heights were never standardized, and
multi-week pattern tracking exceeds human capacity. The 15-min target is itself an approximation —
finding the true mapping is the sweep engine's job (note: 22h ÷ 60 key bars = 22-min candles would
be an exact 1:1 bar mapping; test it).

---

## Components

### A. Alchemy Lab

1. **Daily Capture (automated).** The capture loop drops a rolling history request into the
   GMAExporter inbox, ingests the M1 CSV via loops/backfill_alchemy.js (key hour sliced,
   print aggregated M1→15m locally, machine-scored on arrival). Charts self-rendered SVG
   from that data. No TradingView anywhere in the path; no manual screenshotting.

2. **Verdict Workflow (Mike's 60s/day).** Card in app: day print on top, key hour in all four
   orientations below, plus overlays. Mike clicks the code **blind**, THEN the machine's pick +
   confidence is revealed. Verdict + metadata (day-of-week, news flags, machine scores) → DB.
   - Machine-vs-Mike agreement is tracked. Machine earns auto-labeling rights for historical
     backfill only at ≥85% agreement over ~30 days; every auto-label keeps its visual card for
     spot-audit. Until then it is a rendering assistant, not a judge.

3. **Cake Ventures (the overnight sweep engine).** Named sweep projects. Each venture defines:
   key window (timeframe, start/end time) + print window (session span) + sweep space (print
   timeframes 1m–1h incl. custom intervals like 22m, resampling methods, similarity metrics).
   - **Venture 1 (precoded):** key = 1-min 3–4pm PST; print = 4pm–2pm PST next day; XAUUSD.
   - Additional ventures created by Mike in the UI — the 3–4pm pattern is one of several he sees.
   - Nightly planner (Claude) picks a batch of experiments per venture **with written rationale,
     expected outcome, and metric** — explore/exploit, no experiment "for no good reason."
   - The matching math (thousands of window pairs × 4 orientations × history) runs **locally**
     (numeric, near-zero token cost). Claude plans and reports; the Mac crunches.
   - Output: per-venture experiments log + leaderboard ("best cake so far"), every top combo
     backed by visual proof cards. Weekly digest reports movement.

4. **Amplitude Engine.** Records expansion ratio (day range ÷ key range) per day, distribution
   per orientation → once the day's code is known, project the key hour's swings into price
   targets with confidence bands. Solves "we get alchemy right but don't know how far it goes."

5. **Live Print Tracker.** During session, on each print-timeframe bar close, re-score
   day-so-far vs key under all 4 orientations → live odds panel ("14 bars in: flipV 71%…"),
   projected remaining path for the leading code, alert at confidence threshold. Honest
   "too soon to call" early in session (flipH-family reveals late by construction).

6. **Meta-Pattern Layer.** Orientation calendar in DB → weekly loop hunts higher-order codes:
   day-of-week frequency, transition matrix (what follows a "both" day), streaks, news-day
   effects, expansion-ratio drift. Reports w/ visuals into Weekly Digest.

### A2. Regime Engine

Classifies each session into a market regime (trending-up / trending-down / ranging /
high-vol shock) from measurable inputs (realized vol, ATR, trend strength, range metrics).
Stored per-day in DB; transitions tracked and alerted on the dashboard. Cross-references both
learning channels: orientation-code frequency **per regime** (Alchemy) and strategy performance
**per regime** (Phase 3: promote/demote is regime-aware; Demo Babysitter escalates "regime
changed — strategy unproven in this weather").

### B. Auto trade capture + reconciliation (parallel priority)

1. **MT5 exporter.** Extend GoldBridge EA (or a small companion script) to write closed trades,
   open positions, balance, equity as JSON to the EA `out/` folder every few minutes. Captures
   **all** account trades incl. Mike's manual ones. Kills the manual Eightcap report downloads.
2. **Journal watcher.** Backend tails the folder → auto-creates journal entries (symbol, side,
   size, entry/exit, P&L, swap, commission itemized).
3. **Trade pictures.** Journal Drafter loop, per trade: SELF-RENDERED charts from MT5 M1 data
   on **1-min, 3-min, and 15-min** views (M1 aggregated locally), horizontal lines drawn for
   **entry, SL, exit**, all three attached to the entry. Same feed the fill executed on.
4. **Nightly reconciliation.** Journal computed balance vs MT5-reported. Categorize deltas
   (swap, commission, missed trade, rounding). Recon panel: green when matched to the cent,
   flagged with explanation otherwise. Adjustments are audit-trailed entries, never silent.
   (Explains the existing 10–50 drift — likely un-itemized swaps/commissions.)

### C. Loop Engine

Scheduled headless Claude Code runs (launchd), each: read state → work → write state → escalate
or go quiet. State files + registry in the journal DB.

| Loop | Cadence | Job |
|------|---------|-----|
| Alchemy Capture | 4:01pm PST + session close | §A1 |
| Cake Venture Planner | Nightly | Plan experiments; local sweep executes; morning report |
| Journal Drafter | On new fill | §B3 |
| Recon | Nightly | §B4 |
| Research Loop (Phase 3) | Nightly | Strategy proposals/mutations → backtest via TV strategy tester |
| Verifier (Phase 3) | Per candidate | Adversarial out-of-sample/walk-forward; "find reasons to reject" |
| Demo Babysitter (Phase 3) | 15 min in-session | Demo fills vs backtest expectation; divergence flags |
| Weekly Digest | Sunday | Meta-learning: what's working across BOTH channels (strategies + alchemy) |

Guardrails: $10/day token cap w/ auto-pause; 3-attempt cap → escalate; GoldBridge HALT honored
everywhere; risk/sizing params denylisted (propose-only); every promotion human-gated.

### D. Desk UI (in-app, phased)

- **Alchemy Lab** (Phase 1–2): Verdict cards, venture manager, leaderboards, Live Print Tracker,
  amplitude panels, orientation calendar v2 (DB-backed).
- **Desk Dashboard** (Phase 3): demo equity curves, loop status lights, morning digest,
  escalation queue (stale >24h flagged).
- **Strategy Studio** (Phase 3): registry browser, lineage tree, in-sample/out-of-sample/demo
  metrics side-by-side, Promote/Demote/Retire buttons (the human gates).
- **Loop Console** (Phase 1+): run history, state viewer, cost tracker, escalations.
- **Desk Chat** (Phase 4): Claude w/ tool access to registry/journal/TV MCP.

### E. Strategy channel (Phase 3 — original Minara-style desk)

Registry lifecycle `idea → in-sample → out-of-sample → demo incubation → promoted/retired`,
lineage tracking, `research_moves` meta-table (which idea-generation tactics produce survivors).
Demo deployment via Pine strategy alerts → tv2mt5 → demo MT5 (reuses validated GoldBridge path).

---

## Phases

- **Phase 0 — Foundation (week 1):** DB schema (alchemy days/verdicts/ventures/experiments/trades),
  loop runner + budget guard, launchd schedules, MT5 exporter. **Historical 1-min spine = MT5**
  (broker-served M1, dumpable in bulk via the EA file channel; measure Eightcap's actual depth) —
  TV MCP reads only visible chart bars (500/call) so it stays the visual/live layer, not backfill.
  Fallback for deeper history: archival sources (Dukascopy gold ~2003+).
- **Phase 1 — Daily rhythm (wk 2–3):** Alchemy Capture + Verdict cards + calendar copy-then-verify
  migration; auto trade capture w/ 3-shot pictures; recon panel. *Mike's daily manual workload
  after this: one orientation click.*
- **Phase 2 — The brain (wk 3–6):** Cake Ventures engine + leaderboards; Live Print Tracker;
  Amplitude Engine on the best-cake mapping.
- **Phase 3 — The desk (wk 6–9):** Research/Verifier/Babysitter loops, Strategy Studio, Desk
  Dashboard, first loop-born strategy to demo (L2 — Mike approves every deploy).
- **Phase 4 — Fall:** Desk Chat; DGX Station handoff (high-volume grind → local open-weights,
  Claude stays judgment tier). Hardware order decision ~Sept based on measured token burn.

## Failure modes we design against (from loop-engineering, translated)

- **Verifier theater = overfitting.** Verifier must run real out-of-sample tests on data the maker
  never saw; prompted to reject.
- **Infinite fix loop = strategy churn.** Attempt caps, escalate.
- **Over-reach.** Config denylist; smallest-possible-diff; propose-only on risk params.
- **Token burn.** Local math for brute force; Claude only for judgment; daily cap + auto-pause.
- **Cognitive surrender.** Mike stays the judge — blind verdicts, human gates, weekly digest he
  actually reads. Build it like someone who intends to stay the trader.
