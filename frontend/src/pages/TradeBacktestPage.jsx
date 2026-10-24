import { useState, useEffect } from 'react';
import { LayoutGrid, GitCompare } from 'lucide-react';
import DailySetupPage from './DailySetupPage';
import MetaDriftPage from './MetaDriftPage';

const TABS = [
  { key: 'daily',     label: 'Daily Setup', icon: LayoutGrid },
  { key: 'metadrift', label: 'MetaDrift',   icon: GitCompare },
];

// `tab` prop = route-driven: /daily-setup and /metadrift each render ONE sub-tab with no
// sub-tab bar (they're separate sidebar entries now). Without it, the original two-tab bar stays.
export default function TradeBacktestPage({ tab: routeTab }) {
  const [tab, setTab] = useState(routeTab || 'daily');
  useEffect(() => { if (routeTab) setTab(routeTab); }, [routeTab]);

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab bar (hidden when route-driven) */}
      {!routeTab && <div className="flex items-center gap-1 px-5 pt-4 border-b border-terminal-border">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-mono border-b-2 -mb-px transition-colors ${
              tab === key
                ? 'border-terminal-green text-terminal-green'
                : 'border-transparent text-terminal-muted hover:text-terminal-text'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>}

      {/* Active sub-tab */}
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'daily' ? <DailySetupPage /> : <MetaDriftPage />}
      </div>
    </div>
  );
}
