import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import TenderListPage from '../pages/TenderListPage';
import { defaultPage, makeTender, server } from './mocks';

function FakeDetailPage() {
  const navigate = useNavigate();
  return (
    <div>
      DETAIL PAGE
      <button onClick={() => navigate(-1)}>BACK</button>
    </div>
  );
}

function renderList(ui: React.ReactElement, { route = '/' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/tenders/:refNo" element={<FakeDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TenderListPage', () => {
  it('renders tender rows without Price/Status columns, with Field Code and Source columns', async () => {
    renderList(<TenderListPage status="open" />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
    expect(screen.getByText('UTHM/54/P/02/023/2026')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^price/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^status/i })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /field code/i })).toBeInTheDocument();
    expect(screen.getByText('060501')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^source/i })).toBeInTheDocument();
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByText('myprocurement')).toBeInTheDocument();
  });

  it('shows the Type value as a colored badge', async () => {
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByText('Quotation')).toHaveClass('bg-orange-100');
  });

  it('shows a days-left indicator next to the closing date', async () => {
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByTestId('days-left')).toHaveTextContent(/d left|today|overdue/i);
  });

  it('does not show a days-left indicator on closed or awarded tenders', async () => {
    renderList(<TenderListPage status="closed" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).queryByTestId('days-left')).not.toBeInTheDocument();
  });

  it('shows a filter icon on the Closing Date column header', async () => {
    renderList(<TenderListPage status="open" />);
    const header = await screen.findByRole('columnheader', { name: /closing date/i });
    expect(header.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('wraps the search and filter controls in one card container', async () => {
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    const card = screen.getByTestId('filter-card');
    expect(card).toContainElement(screen.getByPlaceholderText(/search/i));
    expect(card).toContainElement(screen.getByLabelText(/ministry/i));
  });

  it('shows a "Filters" heading with an icon, and a "Clear all" button in the filter card', async () => {
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    const card = screen.getByTestId('filter-card');
    const heading = within(card).getByText('Filters');
    expect(heading.parentElement?.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /clear all/i })).toBeInTheDocument();
  });

  it('resets all filters when "Clear all" is clicked', async () => {
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');

    await userEvent.type(screen.getByPlaceholderText(/search/i), 'makmal');
    await userEvent.selectOptions(screen.getByLabelText(/ministry/i), 'KEMENTERIAN PENDIDIKAN TINGGI');
    fireEvent.change(screen.getByLabelText(/closing from/i), { target: { value: '2026-07-10' } });

    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));

    expect(screen.getByPlaceholderText(/search/i)).toHaveValue('');
    expect(screen.getByLabelText(/ministry/i)).toHaveValue('');
    expect(screen.getByLabelText(/closing from/i)).toHaveValue('');
  });

  it('does not render an Actions column, and clicking a row still navigates to its detail page', async () => {
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;

    expect(screen.queryByRole('columnheader', { name: /actions/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();

    await userEvent.click(row);
    expect(await screen.findByText('DETAIL PAGE')).toBeInTheDocument();
  });

  it('joins multiple sources as separate badges in the Source column', async () => {
    server.use(http.get('/api/tenders', () => HttpResponse.json({
      items: [makeTender({
        sources: [
          { source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' },
          { source: 'span', sourceId: '9', sourceUrl: 'https://example.com/9' },
        ],
      })],
      total: 1, page: 1, pageSize: 20,
    })));
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByText('myprocurement')).toBeInTheDocument();
    expect(within(row).getByText('SPAN')).toBeInTheDocument();
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

  it('hides the Type column when hasWinners is set (Awarded Tenders), and never shows a Ministry column', async () => {
    renderList(<TenderListPage status="closed" hasWinners />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    expect(screen.queryByRole('columnheader', { name: /^ministry$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^type$/i })).not.toBeInTheDocument();
  });

  it('shows the Type column but no Ministry column when hasWinners is not set', async () => {
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    expect(screen.queryByRole('columnheader', { name: /^ministry$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^type$/i })).toBeInTheDocument();
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

  it('populates the Source filter from facets and sends source as a query param on change', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.selectOptions(await screen.findByLabelText(/^source/i), 'span');
    await waitFor(() => expect(requests.some((u) => u.includes('source=span'))).toBe(true));
  });

  it('sends closingFrom and closingTo as query params when the date range is set', async () => {
    const requests: string[] = [];
    server.use(http.get('/api/tenders', ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json(defaultPage);
    }));
    renderList(<TenderListPage status="open" />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    fireEvent.change(screen.getByLabelText(/closing from/i), { target: { value: '2026-07-10' } });
    fireEvent.change(screen.getByLabelText(/closing to/i), { target: { value: '2026-07-20' } });
    await waitFor(() => expect(requests.some((u) =>
      u.includes('closingFrom=2026-07-10') && u.includes('closingTo=2026-07-20'))).toBe(true));
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

  it('keeps the ministry filter selected after navigating to a detail page and back', async () => {
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

    await userEvent.click(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL'));
    expect(await screen.findByText('DETAIL PAGE')).toBeInTheDocument();

    requests.length = 0;
    await userEvent.click(screen.getByText('BACK'));
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');

    expect(screen.getByLabelText(/ministry/i)).toHaveValue('KEMENTERIAN PENDIDIKAN TINGGI');
    await waitFor(() =>
      expect(requests.some((u) => u.includes('ministry=KEMENTERIAN'))).toBe(true));
  });

  it('renders "—" for a null procurementType', async () => {
    server.use(http.get('/api/tenders', () => HttpResponse.json({
      items: [makeTender({ procurementType: null })], total: 1, page: 1, pageSize: 20,
    })));
    renderList(<TenderListPage status="open" />);
    const row = (await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).closest('tr')!;
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  describe('page title (Open Tenders page)', () => {
    it('renders the page title and description for the open tenders page', async () => {
      renderList(<TenderListPage status="open" />);
      expect(await screen.findByRole('heading', { name: 'Open Tenders' })).toBeInTheDocument();
      expect(screen.getByText(/browse and filter/i)).toBeInTheDocument();
    });

    it('does not render the page title on the closed/awarded tenders page', async () => {
      renderList(<TenderListPage status="closed" hasWinners />);
      await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
      expect(screen.queryByRole('heading', { name: 'Open Tenders' })).not.toBeInTheDocument();
    });
  });
});
