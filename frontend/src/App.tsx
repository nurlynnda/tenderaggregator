import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage';
import DetailPage from './pages/DetailPage';
import MinistryDetailPage from './pages/MinistryDetailPage';
import ContractorDetailPage from './pages/ContractorDetailPage';
import SettingsPage from './pages/SettingsPage';
import AboutPage from './pages/AboutPage';
import TenderListPage from './pages/TenderListPage';
import { AuthProvider, useAuth } from './auth/AuthContext';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AdminUsersPage from './pages/AdminUsersPage';

const queryClient = new QueryClient();

function Icon({ path }: { path: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
    </svg>
  );
}

const ICONS = {
  dashboard: 'M4 13h6V4H4v9zm0 7h6v-5H4v5zm10 0h6V11h-6v9zm0-16v5h6V4h-6z',
  open: 'M12 4v16m8-8H4',
  closed: 'M6 6l12 12M18 6L6 18',
  awarded: 'M12 15l-5.5 3 1.5-6.5L3 7l6.5-.5L12 1l2.5 5.5L21 7l-5 4.5 1.5 6.5z',
  about: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 11v6M12 7.5v.01',
};

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return `flex items-center gap-2 px-4 py-2 rounded-md text-[12px] font-bold ${isActive ? 'bg-blue-800 text-white' : 'text-blue-900 hover:bg-blue-50'}`;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function SignedInFooter() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  return (
    <div className="px-4 pt-3 mt-2 border-t border-[#e0e0e0] space-y-1">
      <div className="text-xs text-gray-500 truncate">{user.email}</div>
      <button
        onClick={() => void signOut()}
        className="text-[12px] font-bold text-blue-900 hover:underline"
      >
        Log out
      </button>
    </div>
  );
}

function AppShell() {
  const [isNavOpen, setIsNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setIsNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex flex-col h-screen">
      <header className="w-full bg-blue-900 text-white px-6 py-6 flex items-center justify-between md:justify-end shrink-0">
        <button
          type="button"
          onClick={() => setIsNavOpen((open) => !open)}
          aria-label="Toggle navigation menu"
          className="md:hidden text-white"
        >
          <HamburgerIcon />
        </button>
      </header>
      <div className="flex flex-1 overflow-hidden relative">
        {isNavOpen && (
          <div
            data-testid="nav-backdrop"
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setIsNavOpen(false)}
          />
        )}
        <nav
          className={`fixed inset-y-0 left-0 z-40 w-56 shrink-0 bg-white border-r border-[#e0e0e0] p-4 pt-[22px] flex flex-col overflow-y-auto transition-transform duration-200 md:static md:translate-x-0 ${
            isNavOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex items-center gap-2 mb-4">
            <img src="/favicon.png" alt="" className="w-12 h-12 shrink-0" />
            <div className="text-hero font-semibold text-blue-900">Malaysia Tender Aggregator</div>
          </div>
          <div className="space-y-1">
            <NavLink to="/dashboard" className={navLinkClass}><Icon path={ICONS.dashboard} />Dashboard</NavLink>
            <NavLink to="/open" className={navLinkClass}><Icon path={ICONS.open} />Open Tenders</NavLink>
            <NavLink to="/closed" className={navLinkClass}><Icon path={ICONS.closed} />Closed Tenders</NavLink>
            <NavLink to="/awarded" className={navLinkClass}><Icon path={ICONS.awarded} />Awarded Tenders</NavLink>
          </div>
          <div className="mt-auto space-y-1">
            <NavLink to="/about" className={navLinkClass}><Icon path={ICONS.about} />About</NavLink>
            <NavLink to="/settings" className={navLinkClass}><SettingsIcon />Settings</NavLink>
            {useAuth().user?.role === 'admin' && (
              <NavLink to="/admin/users" className={navLinkClass}>Manage users</NavLink>
            )}
            <SignedInFooter />
          </div>
        </nav>
        <div className="flex-1 flex flex-col overflow-y-auto">
          <main className="px-6 pb-6 pt-[22px] flex-1 bg-[#F8FAFC]">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
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
              <Route
                path="/admin/users"
                element={
                  <RequireAdmin>
                    <AdminUsersPage />
                  </RequireAdmin>
                }
              />
            </Route>
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  );
}
