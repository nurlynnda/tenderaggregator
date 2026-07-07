import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import DetailPage from '../pages/DetailPage';
import { makeTender, server } from './mocks';

function renderDetail(id: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tenders/${encodeURIComponent(id)}`]}>
        <Routes>
          <Route path="/tenders/:id" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DetailPage', () => {
  it('renders all tender fields including events and official link', async () => {
    renderDetail('myprocurement:1');
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.getByText('KEMENTERIAN PENDIDIKAN TINGGI')).toBeInTheDocument();
    expect(screen.getByText('UTHM')).toBeInTheDocument();
    expect(screen.getByText('Perkhidmatan Bukan Perunding')).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
    expect(screen.getByText('2026-07-17')).toBeInTheDocument();
    expect(screen.getByText(/RM\s*28,800/)).toBeInTheDocument();
    expect(screen.getByText('Lawatan Tapak')).toBeInTheDocument();
    expect(screen.getByText('MAKMAL OR, KAJANG')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view on official site/i });
    expect(link).toHaveAttribute('href', 'https://example.com/1');
  });

  it('shows other sources when alsoAvailableFrom is non-empty', async () => {
    server.use(http.get('/api/tenders/:id', () => HttpResponse.json({
      tender: makeTender(),
      alsoAvailableFrom: [makeTender({ id: 'other:9', source: 'other', sourceUrl: 'https://other.example/9' })],
    })));
    renderDetail('myprocurement:1');
    expect(await screen.findByText(/also listed on/i)).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });

  it('shows an error state for unknown ids', async () => {
    renderDetail('nope:1');
    expect(await screen.findByText(/not found|failed/i)).toBeInTheDocument();
  });
});
