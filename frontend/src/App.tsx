import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import ScrapeBanner from './components/ScrapeBanner';
import DetailPage from './pages/DetailPage';
import TenderListPage from './pages/TenderListPage';

const queryClient = new QueryClient();

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `block px-4 py-2 rounded-md text-[12px] ${isActive ? 'bg-blue-800 text-white font-medium' : 'text-blue-900 hover:bg-blue-50'}`;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex h-screen">
          <nav className="w-56 shrink-0 bg-white border-r border-[#e0e0e0] p-4 space-y-1 overflow-y-auto">
            <div className="text-hero font-semibold text-blue-900 mb-4">Malaysia Tender Aggregator</div>
            <NavLink to="/open" className={navLinkClass}>Open Tenders</NavLink>
            <NavLink to="/closed" className={navLinkClass}>Closed Tenders</NavLink>
            <NavLink to="/awarded" className={navLinkClass}>Awarded Tenders</NavLink>
          </nav>
          <div className="flex-1 flex flex-col overflow-y-auto">
            <header className="bg-blue-900 text-white px-6 py-4 flex items-center justify-end shrink-0">
              <ScrapeBanner />
            </header>
            <main className="p-6">
              <Routes>
                <Route path="/" element={<Navigate to="/open" replace />} />
                <Route path="/open" element={<TenderListPage status="open" />} />
                <Route path="/closed" element={<TenderListPage status="closed" />} />
                <Route path="/awarded" element={<TenderListPage status="closed" hasWinners />} />
                <Route path="/tenders/:refNo" element={<DetailPage />} />
              </Routes>
            </main>
          </div>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
