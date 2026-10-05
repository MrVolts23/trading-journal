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
import AlchemyLabPage from './pages/AlchemyLabPage';
// Trading Desk: tabs live under /trading-desk/ (first tab: Trainer). The old Quant Desk pages are in archive/.
import TrainerPage from './pages/tradingDesk/TrainerPage';
import LibraryPage from './pages/tradingDesk/LibraryPage';
import EdgePage from './pages/tradingDesk/EdgePage';
import BacktestPage from './pages/tradingDesk/BacktestPage';
import SkillsPage from './pages/tradingDesk/SkillsPage';
import RiskPage from './pages/tradingDesk/RiskPage';
import TradeJournalPage from './pages/TradeJournalPage';
import KeySetupsPage from './pages/KeySetupsPage';
import KeyLessonsPage from './pages/KeyLessonsPage';
import RiskManagementPage from './pages/RiskManagementPage';
import TradeBacktestPage from './pages/TradeBacktestPage';
import PropManagementPage from './pages/PropManagementPage';
// Calculators batch (2026-09-05): frontend-only pages, inputs remembered in localStorage.
import CompoundingPage from './pages/calc/CompoundingPage';
import ExpectancyPage from './pages/calc/ExpectancyPage';
import MonteCarloPage from './pages/calc/MonteCarloPage';
import CalculatorPage from './pages/calc/CalculatorPage';

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
          <Route path="/alchemy-lab" element={<AlchemyLabPage />} />
          {/* Trading Desk */}
          <Route path="/trading-desk/edge" element={<EdgePage />} />
          <Route path="/trading-desk/skills" element={<SkillsPage />} />
          <Route path="/trading-desk/risk" element={<RiskPage />} />
          <Route path="/trading-desk/exits" element={<Navigate to="/trading-desk/skills" replace />} />
          <Route path="/trading-desk/trainer" element={<TrainerPage />} />
          <Route path="/trading-desk/library" element={<LibraryPage />} />
          <Route path="/trading-desk/backtest" element={<BacktestPage />} />
          {/* Old Quant Desk routes land on the Trading Desk */}
          <Route path="/desk/*"          element={<Navigate to="/trading-desk/trainer" replace />} />
          <Route path="/strategy-studio" element={<Navigate to="/trading-desk/trainer" replace />} />
          <Route path="/loop-console"    element={<Navigate to="/trading-desk/trainer" replace />} />
          <Route path="/lab"             element={<Navigate to="/trading-desk/trainer" replace />} />
          <Route path="/journal" element={<TradeJournalPage />} />
          <Route path="/key-setups" element={<KeySetupsPage />} />
          <Route path="/key-lessons" element={<KeyLessonsPage />} />
          {/* Risk & Reward split into three sidebar tabs (same page, route-driven) */}
          <Route path="/risk"              element={<RiskManagementPage tab="risk" />} />
          <Route path="/account-monitor"   element={<RiskManagementPage tab="monitor" />} />
          <Route path="/reward-management" element={<RiskManagementPage tab="reward" />} />
          {/* Calculators batch: Compounding, Expectancy & Kelly, Monte Carlo */}
          <Route path="/calc/compounding" element={<CompoundingPage />} />
          <Route path="/calc/expectancy"  element={<ExpectancyPage />} />
          <Route path="/calc/monte-carlo" element={<MonteCarloPage />} />
          <Route path="/calc/calculator"  element={<CalculatorPage />} />
          {/* Trade & Backtest split into two sidebar tabs (same page, route-driven) */}
          <Route path="/daily-setup"    element={<TradeBacktestPage tab="daily" />} />
          <Route path="/metadrift"      element={<TradeBacktestPage tab="metadrift" />} />
          <Route path="/trade-backtest" element={<Navigate to="/daily-setup" replace />} />
          <Route path="/prop-management" element={<PropManagementPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
