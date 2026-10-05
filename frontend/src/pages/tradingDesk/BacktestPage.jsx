// Trading Desk · Backtest — placeholder. Mike's idea (2026-10-02): load an edge with its training data and run
// tests where the edge stays the same and only the risk and the exit plan change. To be designed later.
export default function BacktestPage() {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-mono text-terminal-text">Backtest</h1>
        <p className="text-sm font-mono text-terminal-muted leading-relaxed">Not built yet. The idea: pick an edge, keep everything about it the same, and try different risk settings and exit plans against its examples to see what each would have made.</p>
        <p className="text-xs font-mono text-terminal-dim">Placeholder tab, so the spot in the menu is ready.</p>
      </div>
    </div>
  );
}
