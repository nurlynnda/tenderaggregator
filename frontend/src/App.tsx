import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import MainPage from './pages/MainPage';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <header className="bg-blue-900 text-white px-6 py-4 flex items-center justify-between">
          <Link to="/" className="text-lg font-semibold">Malaysia Tender Aggregator</Link>
        </header>
        <main className="p-6">
          <Routes>
            <Route path="/" element={<MainPage />} />
          </Routes>
        </main>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
