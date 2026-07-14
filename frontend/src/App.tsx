import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage';
import DetailPage from './pages/DetailPage';
import MinistryDetailPage from './pages/MinistryDetailPage';
import ContractorDetailPage from './pages/ContractorDetailPage';
import SettingsPage from './pages/SettingsPage';
import AboutPage from './pages/AboutPage';
import TenderListPage from './pages/TenderListPage';

const queryClient = new QueryClient();

function Icon({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  dashboard: 'M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z',
  open: 'M12 4v16m8-8H4',
  closed: 'M6 6l12 12M18 6L6 18',
  awarded: 'M12 15l-5.5 3 1.5-6.5L3 7l6.5-.5L12 1l2.5 5.5L21 7l-5 4.5 1.5 6.5z',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zm7-3a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.3-1a7.3 7.3 0 01-2 1.2L14 22h-4l-.6-2.6a7.3 7.3 0 01-2-1.2l-2.3 1-2-3.4 2-1.6A7 7 0 015 12c0-.4 0-.8.1-1.2l-2-1.6 2-3.4 2.3 1a7.3 7.3 0 012-1.2L10 2h4l.6 2.6a7.3 7.3 0 012 1.2l2.3-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z',
  about: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 11v6M12 7.5v.01',
};

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `flex items-center gap-2 px-4 py-2 rounded-md text-[12px] ${isActive ? 'bg-blue-800 text-white font-medium' : 'text-blue-900 hover:bg-blue-50'}`;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex flex-col h-screen">
          <header className="w-full bg-blue-900 text-white px-6 py-6 flex items-center justify-end shrink-0" />
          <div className="flex flex-1 overflow-hidden">
            <nav className="w-56 shrink-0 bg-white border-r border-[#e0e0e0] p-4 pt-[22px] flex flex-col overflow-y-auto">
              <div className="text-hero font-semibold text-blue-900 mb-4">Malaysia Tender Aggregator</div>
              <div className="space-y-1">
                <NavLink to="/dashboard" className={navLinkClass}><Icon path={ICONS.dashboard} />Dashboard</NavLink>
                <NavLink to="/open" className={navLinkClass}><Icon path={ICONS.open} />Open Tenders</NavLink>
                <NavLink to="/closed" className={navLinkClass}><Icon path={ICONS.closed} />Closed Tenders</NavLink>
                <NavLink to="/awarded" className={navLinkClass}><Icon path={ICONS.awarded} />Awarded Tenders</NavLink>
              </div>
              <div className="mt-auto space-y-1">
                <NavLink to="/about" className={navLinkClass}><Icon path={ICONS.about} />About</NavLink>
                <NavLink to="/settings" className={navLinkClass}><Icon path={ICONS.settings} />Settings</NavLink>
              </div>
            </nav>
            <div className="flex-1 flex flex-col overflow-y-auto">
              <main className="px-6 pb-6 pt-[22px] flex-1 bg-[#F8FAFC]">
                <Routes>
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/dashboard/ministries" element={<MinistryDetailPage />} />
                  <Route path="/dashboard/contractors" element={<ContractorDetailPage />} />
                  <Route path="/" element={<Navigate to="/open" replace />} />
                  <Route path="/open" element={<TenderListPage status="open" />} />
                  <Route path="/closed" element={<TenderListPage status="closed" />} />
                  <Route path="/awarded" element={<TenderListPage status="closed" hasWinners />} />
                  <Route path="/tenders/:refNo" element={<DetailPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/about" element={<AboutPage />} />
                </Routes>
              </main>
            </div>
          </div>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
