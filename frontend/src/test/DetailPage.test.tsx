import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import DetailPage from '../pages/DetailPage';
import { makeTender, server } from './mocks';

function renderDetail(refNo: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/tenders/${encodeURIComponent(refNo)}`]}>
        <Routes>
          <Route path="/tenders/:refNo" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DetailPage', () => {
  it('renders all tender fields including events and official link, without Source/Scraped At rows', async () => {
    renderDetail('UTHM/54/P/02/023/2026');
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.getByText('KEMENTERIAN PENDIDIKAN TINGGI')).toBeInTheDocument();
    expect(screen.getByText('UTHM')).toBeInTheDocument();
    expect(screen.getByText('Perkhidmatan Bukan Perunding')).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
    expect(screen.getByText('17-07-2026')).toBeInTheDocument();
    expect(screen.getByText('07-07-2026')).toBeInTheDocument();
    expect(screen.getByText(/RM\s*28,800/)).toBeInTheDocument();
    expect(screen.getByText('Lawatan Tapak')).toBeInTheDocument();
    expect(screen.getByText('10-07-2026')).toBeInTheDocument();
    expect(screen.getByText('MAKMAL OR, KAJANG')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /view on official site/i });
    expect(link).toHaveAttribute('href', 'https://example.com/1');
    expect(screen.queryByText(/^Source$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Scraped At$/)).not.toBeInTheDocument();
  });

  it('shows a Winners row when winners are present', async () => {
    server.use(http.get('/api/tenders/:refNo', () => HttpResponse.json({
      tender: makeTender({ winners: [{ name: 'EVERLASTING LUCK SDN. BHD.', price: 72000 }] }),
    })));
    renderDetail('UTHM/54/P/02/023/2026');
    expect(await screen.findByText(/EVERLASTING LUCK SDN\. BHD\. — RM 72,000\.00/)).toBeInTheDocument();
  });

  it('shows "Also listed on" when the tender has more than one contributing source', async () => {
    server.use(http.get('/api/tenders/:refNo', () => HttpResponse.json({
      tender: makeTender({
        sources: [
          { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' },
          { source: 'other', sourceId: '9', sourceUrl: 'https://other.example/9' },
        ],
      }),
    })));
    renderDetail('UTHM/54/P/02/023/2026');
    expect(await screen.findByText(/also listed on/i)).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();
  });

  it('does not show "Also listed on" for a single-source tender', async () => {
    renderDetail('UTHM/54/P/02/023/2026');
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    expect(screen.queryByText(/also listed on/i)).not.toBeInTheDocument();
  });

  it('shows an error state for unknown reference numbers', async () => {
    renderDetail('NOPE');
    expect(await screen.findByText(/not found|failed/i)).toBeInTheDocument();
  });

  it('shows "—" for Procurement Type when the source could not classify it', async () => {
    server.use(http.get('/api/tenders/:refNo', () => HttpResponse.json({
      tender: makeTender({ procurementType: null }),
    })));
    renderDetail('UTHM/54/P/02/023/2026');
    const label = await screen.findByText('Procurement Type');
    expect(label.nextElementSibling).toHaveTextContent('—');
  });
});
