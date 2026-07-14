import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import DashboardPage from '../pages/DashboardPage';
import { defaultDashboardStats, server } from './mocks';

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  it('shows headline totals', async () => {
    renderDashboard();
    expect(await screen.findByText('RM 1,000,000.00')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('shows the open-tenders stat cards before the existing dashboard cards, with comma-formatted counts', async () => {
    server.use(http.get('/api/tenders', ({ request }) => {
      const url = new URL(request.url);
      const closingFrom = url.searchParams.get('closingFrom');
      const closingTo = url.searchParams.get('closingTo');
      if (closingFrom && closingFrom === closingTo) {
        return HttpResponse.json({ items: [], total: 3, page: 1, pageSize: 1 });
      }
      if (closingFrom) {
        return HttpResponse.json({ items: [], total: 913, page: 1, pageSize: 1 });
      }
      return HttpResponse.json({ items: [], total: 1483, page: 1, pageSize: 1 });
    }));
    server.use(http.get('/api/dashboard', () =>
      HttpResponse.json({ ...defaultDashboardStats, totalAwardedCount: 139389 })));

    renderDashboard();

    expect(await screen.findByText('Open Tenders')).toBeInTheDocument();
    expect(await screen.findByText('1,483')).toBeInTheDocument();
    expect(await screen.findByText('Closing Today')).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(await screen.findByText('Closing This Week')).toBeInTheDocument();
    expect(await screen.findByText('913')).toBeInTheDocument();
    expect(await screen.findByText('Awarded')).toBeInTheDocument();
    expect(await screen.findByText('139,389')).toBeInTheDocument();

    const labels = ['Open Tenders', 'Closing Today', 'Closing This Week', 'Awarded', 'Total Awarded Value'];
    const positions = labels.map((label) => {
      const el = screen.getByText(label);
      return Array.from(document.body.querySelectorAll('*')).indexOf(el);
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('shows the excludes-N caption when excludedFromValueCount is greater than 0', async () => {
    renderDashboard();
    expect(await screen.findByText(/excludes 3 awards/i)).toBeInTheDocument();
  });

  it('hides the excludes caption when excludedFromValueCount is 0', async () => {
    server.use(http.get('/api/dashboard', () => HttpResponse.json({ ...defaultDashboardStats, excludedFromValueCount: 0 })));
    renderDashboard();
    await screen.findByText('RM 1,000,000.00');
    expect(screen.queryByText(/excludes/i)).not.toBeInTheDocument();
  });

  it('lists ministries by spend with value and count', async () => {
    renderDashboard();
    expect(await screen.findByText('KEMENTERIAN A')).toBeInTheDocument();
    expect(screen.getByText(/RM 600,000\.00 \(3\)/)).toBeInTheDocument();
  });

  it('lists top contractors with wins and value', async () => {
    renderDashboard();
    expect(await screen.findByText(/ACME SDN BHD/)).toBeInTheDocument();
    expect(screen.getByText(/5 wins/)).toBeInTheDocument();
  });

  it('numbers each contractor by rank', async () => {
    renderDashboard();
    expect(await screen.findByText(/^1\.\s*ACME SDN BHD$/)).toBeInTheDocument();
    expect(screen.getByText(/^2\.\s*BETA ENGINEERING$/)).toBeInTheDocument();
  });

  it('sizes the contractor bar by total value won, not win count', async () => {
    renderDashboard();
    const betaRow = (await screen.findByText(/^2\.\s*BETA ENGINEERING$/)).closest('div')!.parentElement!;
    const bar = betaRow.querySelector('.bg-blue-800') as HTMLElement;
    // BETA: totalValue 300000 / ACME's max totalValue 700000 = ~42.86%, not the wins-based 2/5 = 40%
    expect(parseFloat(bar.style.width)).toBeCloseTo((300000 / 700000) * 100, 5);
  });

  it('shows awarded value by year in the order the API returned (ascending)', async () => {
    renderDashboard();
    const heading = await screen.findByRole('heading', { name: 'Awarded Value by Year' });
    const section = heading.closest('section')!;
    const years = within(section).getAllByText(/^20\d{2}$/);
    expect(years.map((el) => el.textContent)).toEqual(['2024', '2025']);
  });

  it('shows tenders awarded by year, next to the value-by-year bars, with counts not values', async () => {
    renderDashboard();
    const heading = await screen.findByRole('heading', { name: 'Tenders Awarded by Year' });
    const section = heading.closest('section')!;
    const years = within(section).getAllByText(/^20\d{2}$/);
    expect(years.map((el) => el.textContent)).toEqual(['2024', '2025']);
    expect(within(section).getByText('4')).toBeInTheDocument();
    expect(within(section).getByText('9')).toBeInTheDocument();
  });

  it('sizes each year-count bar relative to the year with the most tenders awarded', async () => {
    renderDashboard();
    const heading = await screen.findByRole('heading', { name: 'Tenders Awarded by Year' });
    const section = heading.closest('section')!;
    const row2025 = within(section).getByText('2025').closest('div')!.parentElement!;
    const bar = row2025.querySelector('.bg-blue-800') as HTMLElement;
    expect(parseFloat(bar.style.width)).toBe(100); // 2025 has the most (9), so its bar is full width
  });

  it('places the by-year sections above Spend by Ministry and Top Contractors', async () => {
    renderDashboard();
    const valueHeading = await screen.findByRole('heading', { name: 'Awarded Value by Year' });
    const countHeading = await screen.findByRole('heading', { name: 'Tenders Awarded by Year' });
    const ministryHeading = await screen.findByRole('heading', { name: 'Spend by Ministry' });
    const contractorHeading = await screen.findByRole('heading', { name: 'Top Contractors' });
    const order = Array.from(document.body.querySelectorAll('h2')).map((h) => h.textContent);
    expect(order.indexOf(valueHeading.textContent)).toBeLessThan(order.indexOf(ministryHeading.textContent));
    expect(order.indexOf(countHeading.textContent)).toBeLessThan(order.indexOf(contractorHeading.textContent));
  });

  it('styles each year card like the open-tenders stat cards (white, bordered, shadowed)', async () => {
    renderDashboard();
    const heading = await screen.findByRole('heading', { name: 'Awarded Value by Year' });
    const section = heading.closest('section')!;
    const yearCard = within(section).getByText('2024').closest('div')!.parentElement!;
    expect(yearCard).toHaveClass('bg-white', 'border-gray-200', 'rounded-lg', 'shadow-sm');
  });

  it('links "See more" on Spend by Ministry to /dashboard/ministries', async () => {
    renderDashboard();
    await screen.findByText('KEMENTERIAN A');
    const links = screen.getAllByRole('link', { name: /see more/i });
    const ministryLink = links.find((l) => l.getAttribute('href') === '/dashboard/ministries');
    expect(ministryLink).toBeDefined();
  });

  it('links "See more" on Top Contractors to /dashboard/contractors', async () => {
    renderDashboard();
    await screen.findByText(/ACME SDN BHD/);
    const links = screen.getAllByRole('link', { name: /see more/i });
    const contractorLink = links.find((l) => l.getAttribute('href') === '/dashboard/contractors');
    expect(contractorLink).toBeDefined();
  });
});
