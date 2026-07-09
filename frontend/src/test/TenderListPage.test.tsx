import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TenderListPage from '../pages/TenderListPage';
import { defaultPage, makeTender, server } from './mocks';

function renderList(ui: React.ReactElement, { route = '/' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/tenders/:refNo" element={<div>DETAIL PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TenderListPage', () => {
  it('renders tender rows without Source/Price/Status columns, with a Field Code column', async () => {
    renderList(<TenderListPage status="open" />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /source/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^price/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^status/i })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /field code/i })).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
  });

  it('sends status as a fixed param, not a user-facing filter', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="closed" />);
    await waitFor(() => expect(requests.some((u) => u.includes('status=closed'))).toBe(true));
    expect(screen.queryByLabelText(/^status/i)).not.toBeInTheDocument();
  });

  it('sends hasWinners=true and shows separate Contractor and Price Won columns', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json({
        items: [makeTender({ winners: [{ name: 'EVERLASTING LUCK SDN. BHD.', price: 72000 }] })],
        total: 1, page: 1, pageSize: 20,
      });
    }));
    renderList(<TenderListPage status="closed" hasWinners />);
    await waitFor(() => expect(requests.some((u) => u.includes('hasWinners=true'))).toBe(true));
    expect(screen.getByRole('columnheader', { name: /contractor/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /price won/i })).toBeInTheDocument();
    expect(await screen.findByText('EVERLASTING LUCK SDN. BHD.')).toBeInTheDocument();
    expect(await screen.findByText('RM 72,000.00')).toBeInTheDocument();
  });

  it('does not show Contractor/Price Won columns when hasWinners is not set', async () => {
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    expect(screen.queryByRole('columnheader', { name: /contractor/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /price won/i })).not.toBeInTheDocument();
  });

  it('shows a free-text Contractor filter only on hasWinners pages, sending it as a query param (debounced)', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="closed" hasWinners />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.type(await screen.findByLabelText(/contractor/i), 'safworks');
    await waitFor(() =>
      expect(requests.some((u) => u.includes('contractor=safworks'))).toBe(true), { timeout: 2000 });
  });

  it('does not show a Contractor filter when hasWinners is not set', async () => {
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    expect(screen.queryByLabelText(/contractor/i)).not.toBeInTheDocument();
  });

  it('populates filter dropdowns from facets and refetches on change', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.selectOptions(
      await screen.findByLabelText(/ministry/i),
      'KEMENTERIAN PENDIDIKAN TINGGI',
    );
    await waitFor(() =>
      expect(requests.some((u) => u.includes('ministry=KEMENTERIAN'))).toBe(true));
  });

  it('sends search text as a query param (debounced)', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), 'makmal');
    await waitFor(() => expect(requests.some((u) => u.includes('search=makmal'))).toBe(true), { timeout: 2000 });
  });

  it('sends fieldCode as a query param when selected from the field-code filter', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    const input = screen.getByLabelText(/field code/i);
    await userEvent.click(input);
    await userEvent.type(input, '220801');
    await userEvent.click(await screen.findByText(/220801 — Kawalan Keselamatan/));
    await waitFor(() => expect(requests.some((u) => u.includes('fieldCode=220801'))).toBe(true));
  });

  it('toggles sort direction on second click of the same column', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    const closingDateBtn = screen.getByRole('button', { name: /closing date/i });
    await userEvent.click(closingDateBtn);
    await waitFor(() =>
      expect(requests.some((u) => u.includes('sortBy=closingDate') && u.includes('sortOrder=desc'))).toBe(true));
    await userEvent.click(closingDateBtn);
    await waitFor(() =>
      expect(requests.some((u) => u.includes('sortBy=closingDate') && u.includes('sortOrder=asc'))).toBe(true));
  });

  it('paginates', async () => {
    server.use(http.get('/api/tenders', ({ request }) => {
      const page = new URL(request.url).searchParams.get('page') ?? '1';
      return HttpResponse.json({
        items: [makeTender({ dedupKey: `p${page}`, referenceNo: `p${page}`, title: `PAGE ${page} ITEM` })],
        total: 45, page: Number(page), pageSize: 20,
      });
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('PAGE 1 ITEM');
    expect(screen.getByText(/45/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('PAGE 2 ITEM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('PAGE 1 ITEM')).toBeInTheDocument();
  });

  it('navigates to the detail page by reference number on row click', async () => {
    renderList(<TenderListPage status="open" />);
    await userEvent.click(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL'));
    expect(await screen.findByText('DETAIL PAGE')).toBeInTheDocument();
  });
});
