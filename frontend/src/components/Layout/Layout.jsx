import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopNav from './TopNav';

export default function Layout() {
  const [account, setAccount] = useState('All');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');

  const handleDateChange = (which, val) => {
    if (which === 'start') setDateStart(val);
    else setDateEnd(val);
  };

  const filters = { account, dateStart, dateEnd };

  return (
    <div className="flex h-screen overflow-hidden bg-terminal-bg">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopNav
          account={account}
          onAccountChange={setAccount}
          dateStart={dateStart}
          dateEnd={dateEnd}
          onDateChange={handleDateChange}
        />
        <main className="flex-1 overflow-auto">
          <Outlet context={filters} />
        </main>
      </div>
    </div>
  );
}
