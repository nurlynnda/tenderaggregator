import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import ContractorDetailPage from '../pages/ContractorDetailPage';
import { defaultDashboardStats } from './mocks';

function FakeDashboardPage() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/dashboard/contractors')}>GO TO CONTRACTORS</button>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['dashboard'], defaultDashboardStats);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/dashboard', '/dashboard/contractors']} initialIndex={1}>
        <Routes>
          <Route path="/dashboard" element={<FakeDashboardPage />} />
          <Route path="/dashboard/contractors" element={<ContractorDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ContractorDetailPage', () => {
  it('lists every contractor, including ones beyond the dashboard top 10, with wins and value', async () => {
    renderPage();
    expect(await screen.findByText(/ACME SDN BHD/)).toBeInTheDocument();
    expect(screen.getByText(/BETA ENGINEERING/)).toBeInTheDocument();
    expect(screen.getByText(/GAMMA WORKS/)).toBeInTheDocument();
    expect(screen.getByText(/5 wins · RM 700,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1 wins · RM 50,000\.00/)).toBeInTheDocument();
  });

  it('numbers each contractor by rank, including ones beyond the dashboard top 10', async () => {
    renderPage();
    expect(await screen.findByText(/^1\.\s*ACME SDN BHD$/)).toBeInTheDocument();
    expect(screen.getByText(/^2\.\s*BETA ENGINEERING$/)).toBeInTheDocument();
    expect(screen.getByText(/^3\.\s*GAMMA WORKS$/)).toBeInTheDocument();
  });

  it('sizes each contractor bar by total value won, not win count', async () => {
    renderPage();
    const gammaRow = (await screen.findByText(/^3\.\s*GAMMA WORKS$/)).closest('div')!.parentElement!;
    const bar = gammaRow.querySelector('.bg-blue-800') as HTMLElement;
    // GAMMA: totalValue 50000 / ACME's max totalValue 700000 = ~7.14%, not the wins-based 1/5 = 20%
    expect(parseFloat(bar.style.width)).toBeCloseTo((50000 / 700000) * 100, 5);
  });

  it('navigates back when the back link is clicked', async () => {
    renderPage();
    await screen.findByText(/ACME SDN BHD/);
    await userEvent.click(screen.getByRole('button', { name: /back to dashboard/i }));
    expect(await screen.findByText('GO TO CONTRACTORS')).toBeInTheDocument();
  });
});
