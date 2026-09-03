import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout/Layout';
import DashboardPage from './pages/DashboardPage';
import TradeLogPage from './pages/TradeLogPage';
import CalendarPage from './pages/CalendarPage';
import ImportPage from './pages/ImportPage';
import SettingsPage from './pages/SettingsPage';
import WithdrawalPlanPage from './pages/WithdrawalPlanPage';
import AlchemyPage from './pages/AlchemyPage';
import AlchemyCalendarPage from './pages/AlchemyCalendarPage';
import TradeJournalPage from './pages/TradeJournalPage';
import KeySetupsPage from './pages/KeySetupsPage';
import KeyLessonsPage from './pages/KeyLessonsPage';
import RiskManagementPage from './pages/RiskManagementPage';
import TradeBacktestPage from './pages/TradeBacktestPage';

export default function App() {
  // Restore saved theme on first load
  useEffect(() => {
    if (localStorage.getItem('theme') === 'light') {
      document.documentElement.classList.add('light');
    }
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/trades" element={<TradeLogPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/withdrawal-plan" element={<WithdrawalPlanPage />} />
          <Route path="/alchemy" element={<AlchemyPage />} />
          <Route path="/alchemy-calendar" element={<AlchemyCalendarPage />} />
          <Route path="/journal" element={<TradeJournalPage />} />
          <Route path="/key-setups" element={<KeySetupsPage />} />
          <Route path="/key-lessons" element={<KeyLessonsPage />} />
          {/* Risk & Reward split into three sidebar tabs (same page, route-driven) */}
          <Route path="/risk"              element={<RiskManagementPage tab="risk" />} />
          <Route path="/account-monitor"   element={<RiskManagementPage tab="monitor" />} />
          <Route path="/reward-management" element={<RiskManagementPage tab="reward" />} />
          {/* Trade & Backtest split into two sidebar tabs (same page, route-driven) */}
          <Route path="/daily-setup"    element={<TradeBacktestPage tab="daily" />} />
          <Route path="/metadrift"      element={<TradeBacktestPage tab="metadrift" />} />
          <Route path="/trade-backtest" element={<Navigate to="/daily-setup" replace />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
