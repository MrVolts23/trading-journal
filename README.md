# Mike's Trading Journal

A local trading journal app built for forex/gold trading. Dark terminal theme, runs entirely on your own machine — no cloud, no subscriptions.

---

## Before You Start — Prerequisites

You need **Node.js** installed. If you're not sure whether you have it, open Terminal and run:

```bash
node -v
```

If you get a version number (e.g. `v20.11.0`) you're good. If you get an error, install Node.js from:

**https://nodejs.org** — download the **LTS** version and install it like any normal app.

---

## First-Time Setup

1. Download the zip file Mike sent you and move it to your **Downloads** folder
2. Open **Terminal**
3. Paste this one command and press Enter:

```bash
pkill -f "node src/index.js"; pkill -f "vite"; sleep 1; cd ~/Downloads && rm -rf trading-journal && unzip -o trading-journal.zip && cd trading-journal && npm install --prefix backend && npm install --prefix frontend && bash start.sh
```

This will install everything and start the app. The first run takes a minute or two while it installs packages. After that, open your browser and go to:

**http://localhost:5173**

---

## Starting the App After the First Time

Use the same command above. It kills any old server, loads the latest version, and starts fresh. Your trading data is never touched — it lives in a separate folder (`trading-journal-data/` next to the app) and persists across every update.

---

## Getting Updates

When Mike sends you a new zip, it will always be called **trading-journal.zip**. Replace the old one in your Downloads folder with the new one, then run the same command above. Your data stays intact. You don't need to keep old versions.

---

## Features

**Dashboard** — Live account balance, net P&L, win rate, profit factor, expectancy, equity curve and drawdown charts.

**Trade Log** — Full trade history, sortable and filterable. Inline lesson notes. CSV export.

**Calendar** — Monthly P&L heatmap with trade counts, win rate per day, deposits/withdrawals marked, and Forex Factory news events shown as lightning bolt indicators on relevant days.

**MetaDrift** — Backtesting calendar. Enter what your RR would have been on past trading days and see a compounded projection of what a perfectly-executed strategy would have returned.

**Alchemy** — Multi-tab image flipper. Upload chart screenshots and flip them horizontally, vertically, or both to practise reading price action without bias.

**Alchemy Calendar** — Tag each trading day with which flip transformation you applied (None / Flip H / Flip V / Both). Tracks your review history across the month.

**Settings** — Account management, deposits and withdrawals, balance corrections, withdrawal plan, and Forex Factory news currency preferences.

---

## Your Data

All trading data is stored in a SQLite database at:

```
~/Downloads/trading-journal-data/journal.db
```

Back this file up occasionally — it contains all your trades, accounts, and notes.

---

## CSV Import

Supports EightCap CSV format out of the box. The field mapper lets you configure it for other brokers too.

Default EightCap field mapping:
- Position → trade_id
- Symbol → symbol
- Type → position (Long/Short)
- Open Time → entry_datetime
- Close Time → exit_datetime
- Profit → pnl
- Commission → commission
- Volume → lot_size

---

## Troubleshooting

**Port already in use / app won't start** — run the startup command again, it kills old servers automatically.

**Page is blank or shows an error** — try a hard refresh (`Cmd+Shift+R` on Mac, `Ctrl+Shift+R` on Windows).

**News events not showing** — the app pulls Forex Factory data for the current and next week. Events populate automatically in the background. Check Settings → News Currencies to make sure your relevant currencies are selected (USD covers gold/XAU).
