import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import ScrapeBanner from '../components/ScrapeBanner';
import { server } from './mocks';

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScrapeBanner />
    </QueryClientProvider>,
  );
}

describe('ScrapeBanner', () => {
  it('shows an enabled Rescrape button when idle', async () => {
    renderBanner();
    const btn = await screen.findByRole('button', { name: /rescrape/i });
    expect(btn).toBeEnabled();
  });

  it('shows progress and disables the button while running', async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'myprocurement', job: 'open-tender',
      jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96,
    })));
    renderBanner();
    expect(await screen.findByText(/open-tender/)).toBeInTheDocument();
    expect(screen.getByText(/12\s*\/\s*96/)).toBeInTheDocument();
    expect(screen.getByText(/job 2\s*\/\s*3/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rescrape/i })).toBeDisabled();
  });

  it('shows the error message when failed', async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'failed', error: 'fetch failed after 3 attempts: url',
    })));
    renderBanner();
    expect(await screen.findByText(/fetch failed after 3 attempts/)).toBeInTheDocument();
  });

  it('triggers a scrape on click', async () => {
    let posted = false;
    server.use(http.post('/api/scrape', () => { posted = true; return HttpResponse.json({ started: true }, { status: 202 }); }));
    renderBanner();
    await userEvent.click(await screen.findByRole('button', { name: /rescrape/i }));
    await waitFor(() => expect(posted).toBe(true));
  });

  it('invalidates tenders and facets when a run transitions out of running', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'myprocurement', job: 'open-tender',
      jobsCompleted: 1, jobsTotal: 3, currentPage: 12, lastPage: 96,
    })));
    render(
      <QueryClientProvider client={qc}>
        <ScrapeBanner />
      </QueryClientProvider>,
    );
    await screen.findByText(/open-tender/);

    qc.setQueryData(['scrape-status'], { state: 'idle' });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['tenders'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['facets'] });
    });
  });
});
