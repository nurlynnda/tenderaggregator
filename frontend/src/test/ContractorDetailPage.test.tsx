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
    expect(await screen.findByText('ACME SDN BHD')).toBeInTheDocument();
    expect(screen.getByText('BETA ENGINEERING')).toBeInTheDocument();
    expect(screen.getByText('GAMMA WORKS')).toBeInTheDocument();
    expect(screen.getByText(/5 wins · RM 700,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/1 wins · RM 50,000\.00/)).toBeInTheDocument();
  });

  it('navigates back when the back link is clicked', async () => {
    renderPage();
    await screen.findByText('ACME SDN BHD');
    await userEvent.click(screen.getByRole('button', { name: /back to dashboard/i }));
    expect(await screen.findByText('GO TO CONTRACTORS')).toBeInTheDocument();
  });
});
