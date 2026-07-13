import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
    const years = await screen.findAllByText(/^20\d{2}$/);
    expect(years.map((el) => el.textContent)).toEqual(['2024', '2025']);
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
