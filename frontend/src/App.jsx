import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
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
import MetaDriftPage from './pages/MetaDriftPage';

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
          <Route path="/risk" element={<RiskManagementPage />} />
          <Route path="/metadrift" element={<MetaDriftPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
