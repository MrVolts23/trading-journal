# Trading Desk — build log

Decisions Mike has made, in plain language, so nobody reopens them by accident. Newest at the bottom of each section.

## What the Trading Desk is

- Teach the desk an already-proven entry (Mike's 1-2-3 break of structure) from labelled chart examples. The gate model (Cloudflare Clef, run locally on Mike's Macs) judges setups; a local chat model (Gemma now, something smarter later) is a talking partner only.
- Gold prices come from the Eightcap demo MetaTrader, on purpose: best gold charts and liquidity available to Canadians. Mike's TradingView is on FTMO/OANDA, so candles differ slightly — not a bug.
- One entry system for now (the 1-2-3). No "entry type" dropdown until a second entry exists.
- Nothing is shipped to the installed journal until Mike says "ship it". The preview runs on port 5185 with its own data copy.

## Tabs (Trading Desk group in the journal)

Skills → Edges → Risk → Trainer → Library → Backtest (placeholder). (Exits folded into Skills / the Edge's "How it exits", 2026-10-04.)

## Skills architecture (Mike, 2026-10-04)

- **The Trainer trains skills, not edges.** An example is one chart moment labelled for whichever skills apply (3-minute marks → 3-minute break skill, 15-minute marks → 15-minute break skill, exit marks → exit-structure skill, plus a trend call: EMA guess that Mike confirms). The edge is a tag only.
- **A skill** is one judgement with a fixed answer shape. Two kinds: *taught* (Clef answers its questions from pictures; examples teach it) and *arithmetic* (a formula; nothing to train). Categories: Entries, Exits, Conditions, Trade construction, Invalidation. Construction and Invalidation hold examples only for now; how they run is still to be worked out.
- **An edge is a recipe:** the skills it uses with what each must say (Clef at least N% sure; direction must match), plain-English prerequisites, the entry window, the instrument, and its own exit (the exit triggers). No judgement of its own, no risk.
- **Risk profiles** live on the Risk tab, per account type (demo / live / prop). Picked per test in Backtest and per account on the live desk.
- Typed answers with probabilities, or arithmetic — nothing else gets to vote. No free-form prompts as skills.

## Rules the app enforces

- **Market days.** A market day starts 2 PM Vancouver (forex) / 3 PM (metals) and runs to the next afternoon, Monday–Friday; weekends roll to Monday. A trade belongs to the market day of its EXIT (entry while open). Used everywhere in the journal and the desk. FTMO's prop page stays on Prague time.
- **1-2-3 entry.** Points 1–3 are tops/bottoms of finished candles (buy: bottom, top, bottom); 3 must be a pullback inside 1–2, and 3 past 1 invalidates. Entry = point 2 + buffer + spread; point 4 = the first minute price reaches it after point 3 closes. Pending orders / "arm the trail on a continuation break" were parked as too much noise — just mark 1, 2, 3, 4.
- **Exit 1-2-3.** The same pattern the other way, marked after the entry; E4 = the minute E2 breaks. Used by exit plans with a "Break of structure" trigger.
- **Marks stay on the chart they were made on.** 1-2-3 entry and exit points do not mirror; boxes, lines, levels, labels and best-exit do. Each picture shows only the calls made on that timeframe, so Clef must read 15-minute structure itself.
- **Pictures.** Always saved with the scale locked: a fixed number of pixels per $-step (22 px per $4 by default), candles 8 px, centred on the marks, chart at its on-screen size. "Lock scale" previews it; the step is adjustable.
- **Edge window = entry window only.** Open trades are held until the exit plan fires.

## Exits

- Exit plans are their own objects (Exits tab), shared by edges; each example records the plan it was taught with and its result is worked out under that plan. Triggers: fixed target, R-step trail, breakeven, partial close, flat-by-time, break of structure (hand-marked; the app cannot detect structure by itself yet).

## Edges

- Two edges planned for gold:
  - **A — Tokyo open, 3-minute break:** entry window 5:00–6:00 PM Vancouver; the 3-minute 1-2-3 alone is the entry.
  - **B — After 6, 15-minute break then 3-minute entry:** entry window ~6:10/6:15–7:38 PM; needs a 15-minute 1-2-3 break first, then a 3-minute 1-2-3 entry inside or just after it. Open questions: must the 15-minute point 2 break before the 3-minute point 3 forms, or just before the entry fires? Is 5–6 PM strict?
- The live desk runs several edges at once, each its own watcher with its own clock.

## Risk (decided 2026-10-03)

- Risk belongs to the ACCOUNT, not the edge. An Eightcap CFD cash account loaded into the platform carries the risk rules for the whole account (% per trade, max open, daily loss stop, losses in a row).
- Therefore risk comes OUT of the Edge rulebook and goes: per test in the Backtest tab, and per account on the live desk (demo now, live later). Trade size on the live desk = the account's rules × the account's live balance at entry.
- With several edges on one account, the account's limits are the ceiling the edges share.
- 2026-10-03: the "How much it risks" section was removed from the Edge page (fields kept in the database, unused).
- Paper trading and live trading both happen in the live trading desk (not in Backtest). Backtest works on saved examples only.

## Scanning design (Mike, 2026-10-04 — not coded yet)

- No mechanical setup-finder. The app takes pictures often (many per candle, ahead of the close) and Clef reads them like a human.
- A possible 1-2 always exists in both directions (latest top + latest bottom); the system is never idle.
- 3 is only ever "possible"; the 4 (break of point 2) confirms it and is the entry. The app arms the trigger at point 2.
- To get point 2's price for the trigger, the app may label recent swing levels on the picture and ask Clef which is point 2.
- **Never call a reversal: only take a 1-2-3 in the direction of the trend.** Trend definition for the app still to be stated.
- Picture cadence (every few seconds, picture size) to be tuned; Clef-flash answers in ~5 s per picture today.

## Live desk design (not built)

- Two layers: a fast tick watcher (mechanical "has price crossed point 2?" → order within a second, so no entry is missed) and Clef judging at each candle close ("valid 1-2-3 with these points?" → arms the watcher). Mike never feeds Clef pictures by hand; the app takes them.
- Snapshots every second kept in a rolling cache (~30 min) for review and for turning a moment into a training example on the spot.
- Live spread from the data robot (and per-minute historical spread) still to be wired — robot update + re-pull.

## To do

1. ~~Ship~~ v1.0.27 published 2026-10-05 (notarized). Verify the installed app picked it up and that the first-start migrations ran cleanly on the real journal.
2. ~~Move risk out of the Edge rulebook~~ (done) → add risk settings to Backtest (per test) and the live desk (per account).
3. Per-chart 1-2-3 sets for Edge B (15-minute context set + 3-minute entry set) — after the two timing questions are answered.
4. Market-condition prerequisites section on the Edge (time-of-day rules etc.).
5. Data robot: live spread + historical spread.
6. Gemma chat tab (Ollama). (Gemma 3 12B is installed via Ollama, 2026-10-03.)
7. ~~Clef on the MacBook~~ installed 2026-10-03; **Ask Clef** built 2026-10-04 (Trainer + Library; one record per taught skill; runs stored verbatim; questions edited on the Skills tab). Still: `~/Projects/alchemy-clef` (Clef-flash 8-bit, MLX), `clef_ask.py` answers the 1-2-3 questions on a saved picture in ~7 s. Next: wire it to the desk and tune the questions on real examples.
8. The gate: yes/no from examples, measured on unseen ones. Daily scheduled check for a Clef fine-tuning recipe is already running (8:12 AM).
9. Demo hands: trading robot in the demo MetaTrader (order within 1 s, stop and size from the account's rules).
10. Backtest tab: load an edge, vary exit plans and risk settings over its examples.
11. Account rules section (account-wide limits above edges).
