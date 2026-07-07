import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import MainPage from '../pages/MainPage';
import { defaultPage, makeTender, server } from './mocks';

export function renderWithProviders(ui: React.ReactElement, { route = '/' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/tenders/:id" element={<div>DETAIL PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MainPage', () => {
  it('renders tender rows from the API', async () => {
    renderWithProviders(<MainPage />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
  });

  it('populates filter dropdowns from facets and refetches on change', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderWithProviders(<MainPage />);
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
    renderWithProviders(<MainPage />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), 'makmal');
    await waitFor(() => expect(requests.some((u) => u.includes('search=makmal'))).toBe(true), { timeout: 2000 });
  });

  it('toggles sort on column header click', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderWithProviders(<MainPage />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.click(screen.getByRole('button', { name: /closing date/i }));
    await waitFor(() => expect(requests.some((u) => u.includes('sortBy=closingDate'))).toBe(true));
  });

  it('paginates', async () => {
    server.use(http.get('/api/tenders', ({ request }) => {
      const page = new URL(request.url).searchParams.get('page') ?? '1';
      return HttpResponse.json({
        items: [makeTender({ id: `myprocurement:p${page}`, title: `PAGE ${page} ITEM` })],
        total: 45, page: Number(page), pageSize: 20,
      });
    }));
    renderWithProviders(<MainPage />);
    await screen.findByText('PAGE 1 ITEM');
    expect(screen.getByText(/45/)).toBeInTheDocument(); // total shown
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('PAGE 2 ITEM')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous/i })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(await screen.findByText('PAGE 1 ITEM')).toBeInTheDocument();
  });

  it('navigates to the detail page on row click', async () => {
    renderWithProviders(<MainPage />);
    await userEvent.click(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL'));
    expect(await screen.findByText('DETAIL PAGE')).toBeInTheDocument();
  });

  it('sends status filter as a query param', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderWithProviders(<MainPage />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.selectOptions(screen.getByLabelText(/status/i), 'open');
    await waitFor(() => expect(requests.some((u) => u.includes('status=open'))).toBe(true));
  });

  it('toggles sort direction on second click of the same column, and sorts by price', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderWithProviders(<MainPage />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    const closingDateBtn = screen.getByRole('button', { name: /closing date/i });
    await userEvent.click(closingDateBtn);
    await waitFor(() =>
      expect(requests.some((u) => u.includes('sortBy=closingDate') && u.includes('sortOrder=desc'))).toBe(true));
    await userEvent.click(closingDateBtn);
    await waitFor(() =>
      expect(requests.some((u) => u.includes('sortBy=closingDate') && u.includes('sortOrder=asc'))).toBe(true));

    await userEvent.click(screen.getByRole('button', { name: /^price/i }));
    await waitFor(() => expect(requests.some((u) => u.includes('sortBy=indicativePrice'))).toBe(true));
  });
});
