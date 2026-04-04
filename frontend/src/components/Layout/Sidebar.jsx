import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { LayoutDashboard, TableProperties, Calendar, FileUp, Settings, TrendingUp, PiggyBank, FlaskConical, BookOpen, Layers, BookMarked, ShieldCheck, GitCompare } from 'lucide-react';
import { getSettings } from '../../lib/api';

function useIsLight() {
  const [isLight, setIsLight] = useState(() =>
    document.documentElement.classList.contains('light')
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsLight(document.documentElement.classList.contains('light'))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isLight;
}

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/trades', label: 'Trade Log', icon: TableProperties },
  { to: '/journal', label: 'Trade Journal', icon: BookOpen },
  { to: '/calendar', label: 'Calendar', icon: Calendar },
  { to: '/metadrift', label: 'MetaDrift', icon: GitCompare, activeColor: 'text-purple-400 border-purple-400' },
  { to: '/withdrawal-plan', label: 'Withdrawal Plan', icon: PiggyBank },
  { to: '/alchemy', label: 'Alchemy', icon: FlaskConical },
  { to: '/alchemy-calendar', label: 'Alchemy Calendar', icon: FlaskConical },
  { to: '/key-setups', label: 'Key Setups', icon: Layers },
  { to: '/key-lessons', label: 'Key Lessons', icon: BookMarked, activeColor: 'text-terminal-red border-terminal-red' },
  { to: '/risk', label: 'Risk Management', icon: ShieldCheck, activeColor: 'text-blue-400 border-blue-400' },
  { to: '/import', label: 'Import', icon: FileUp },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const isLight = useIsLight();
  const [journalName, setJournalName] = useState(() => localStorage.getItem('journal_name') || '');
  const [logoError, setLogoError] = useState(false);
  const logoSrc = isLight ? '/logo-light.png' : '/logo-dark.png';
  useEffect(() => {
    // Sync from backend on load (in case localStorage is stale or first install)
    getSettings().then(s => {
      const name = s?.journal_name || '';
      setJournalName(name);
      if (name) localStorage.setItem('journal_name', name);
    }).catch(() => {});
    // Listen for live updates when Settings page saves
    const handler = (e) => setJournalName(e.detail || '');
    window.addEventListener('journal-name-changed', handler);
    return () => window.removeEventListener('journal-name-changed', handler);
  }, []);

  return (
    <aside className="w-56 flex-shrink-0 bg-terminal-surface border-r border-terminal-border flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="px-3 py-4 border-b border-terminal-border">
        {!logoError ? (
          <img
            src={logoSrc}
            alt="Alchemy8"
            onError={() => setLogoError(true)}
            className="w-full object-contain"
            style={{ maxHeight: '48px' }}
          />
        ) : (
          /* Fallback to text if image files aren't in place yet */
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-terminal-green" />
            <div>
              <div className="text-sm font-mono font-semibold text-terminal-text">TRADE LOG</div>
              <div className="text-[10px] font-mono text-terminal-dim uppercase tracking-widest">{journalName || 'My Journal'}</div>
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-4 space-y-0.5">
        {nav.map(({ to, label, icon: Icon, activeColor }) => {
          const activeClass = activeColor
            ? `bg-terminal-hover ${activeColor} border-l-2 pl-[10px]`
            : 'bg-terminal-hover text-terminal-green border-l-2 border-terminal-green pl-[10px]';
          return (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded text-sm font-mono transition-colors ${
                  isActive
                    ? activeClass
                    : 'text-terminal-muted hover:text-terminal-text hover:bg-terminal-hover border-l-2 border-transparent pl-[10px]'
                }`
              }
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </NavLink>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-terminal-border">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-terminal-green animate-pulse" />
          <span className="text-[10px] font-mono text-terminal-dim">LIVE</span>
        </div>
      </div>
    </aside>
  );
}
