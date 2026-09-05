import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopNav from './TopNav';
import DeskChat from '../desk/DeskChat';

export default function Layout() {
  const [account, setAccount] = useState('All');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');

  const handleDateChange = (which, val) => {
    if (which === 'start') setDateStart(val);
    else setDateEnd(val);
  };

  const filters = { account, dateStart, dateEnd };
  // "Talk to the desk" lives only on the Quant Desk pages (/desk/...).
  const { pathname } = useLocation();
  const onDesk = pathname.startsWith('/desk');

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
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <main className="flex-1 min-w-0 overflow-auto">
            <Outlet context={filters} />
          </main>
          {onDesk && <DeskChat />}
        </div>
      </div>
    </div>
  );
}
