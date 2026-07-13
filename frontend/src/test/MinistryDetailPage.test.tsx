import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import MinistryDetailPage from '../pages/MinistryDetailPage';
import { defaultDashboardStats } from './mocks';

function FakeDashboardPage() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/dashboard/ministries')}>GO TO MINISTRIES</button>;
}

function renderPage({ prefetch = true } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (prefetch) {
    qc.setQueryData(['dashboard'], defaultDashboardStats);
  }
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/dashboard', '/dashboard/ministries']} initialIndex={1}>
        <Routes>
          <Route path="/dashboard" element={<FakeDashboardPage />} />
          <Route path="/dashboard/ministries" element={<MinistryDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MinistryDetailPage', () => {
  it('lists every ministry, including ones beyond the dashboard top 10, sorted by spend', async () => {
    renderPage();
    expect(await screen.findByText('KEMENTERIAN A')).toBeInTheDocument();
    expect(screen.getByText('KEMENTERIAN B')).toBeInTheDocument();
    expect(screen.getByText('KEMENTERIAN C')).toBeInTheDocument();
    expect(screen.getByText(/RM 600,000\.00 \(3\)/)).toBeInTheDocument();
    expect(screen.getByText(/RM 100,000\.00 \(1\)/)).toBeInTheDocument();
  });

  it('navigates back when the back link is clicked', async () => {
    renderPage();
    await screen.findByText('KEMENTERIAN A');
    await userEvent.click(screen.getByRole('button', { name: /back to dashboard/i }));
    expect(await screen.findByText('GO TO MINISTRIES')).toBeInTheDocument();
  });
});
