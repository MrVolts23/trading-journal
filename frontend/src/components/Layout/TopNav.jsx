import { useState, useEffect } from 'react';
import { ChevronDown, Sun, Moon } from 'lucide-react';
import { getAccounts } from '../../lib/api';

export default function TopNav({ account, onAccountChange, dateStart, dateEnd, onDateChange }) {
  const [accounts, setAccounts] = useState([]);
  const [isLight, setIsLight] = useState(() =>
    document.documentElement.classList.contains('light')
  );

  // Fetch on mount, then refresh every 30 s so newly imported accounts
  // (e.g. "Paper Trading") appear without requiring a full page reload.
  useEffect(() => {
    const load = () => getAccounts().then(data => setAccounts(data)).catch(() => {});
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  const toggleTheme = () => {
    const next = !isLight;
    setIsLight(next);
    if (next) {
      document.documentElement.classList.add('light');
      localStorage.setItem('theme', 'light');
    } else {
      document.documentElement.classList.remove('light');
      localStorage.setItem('theme', 'dark');
    }
  };

  return (
    <header className="h-14 bg-terminal-surface border-b border-terminal-border flex items-center px-6 gap-4 sticky top-0 z-10">
      {/* Account selector */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-terminal-muted uppercase tracking-wider">Account</span>
        <div className="relative">
          <select
            value={account}
            onChange={e => onAccountChange(e.target.value)}
            className="select-field pr-8 text-xs appearance-none"
          >
            <option value="All">All Accounts</option>
            {accounts.map(a => (
              <option key={a.id} value={a.name}>{a.name}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-terminal-muted pointer-events-none" />
        </div>
      </div>

      <div className="w-px h-6 bg-terminal-border" />

      {/* Date range */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-terminal-muted uppercase tracking-wider">From</span>
        <input
          type="date"
          value={dateStart}
          onChange={e => onDateChange('start', e.target.value)}
          className="input-field text-xs py-1.5"
        />
        <span className="text-xs font-mono text-terminal-muted">to</span>
        <input
          type="date"
          value={dateEnd}
          onChange={e => onDateChange('end', e.target.value)}
          className="input-field text-xs py-1.5"
        />
        {(dateStart || dateEnd) && (
          <button
            onClick={() => { onDateChange('start', ''); onDateChange('end', ''); }}
            className="text-xs font-mono text-terminal-muted hover:text-terminal-red transition-colors"
          >
            ✕ Clear
          </button>
        )}
      </div>

      <div className="ml-auto flex items-center gap-4">
        <span className="text-xs font-mono text-terminal-dim">
          {new Date().toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
        </span>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
          className="flex items-center justify-center w-7 h-7 rounded border border-terminal-border text-terminal-muted hover:text-terminal-text hover:border-terminal-dim transition-colors"
        >
          {isLight ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
        </button>
      </div>
    </header>
  );
}
