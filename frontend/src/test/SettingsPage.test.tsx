import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import SettingsPage from '../pages/SettingsPage';
import { server } from './mocks';
import { AuthProvider } from '../auth/AuthContext';

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })));
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function renderSettingsAsMember() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Member', email: 'member@example.com', role: 'member' })));
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('SettingsPage', () => {
  it('lists each source with its last-fetched info and two fetch buttons', async () => {
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).getByText(/never/)).toBeInTheDocument();
    expect(within(spanRow).getByRole('button', { name: /fetch open/i })).toBeInTheDocument();
    expect(within(spanRow).getByRole('button', { name: /full refresh/i })).toBeInTheDocument();
    const mpRow = screen.getByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).getByText(/5775 tenders/)).toBeInTheDocument();
  });

  it("clicking Fetch open sends that row's source with scope=open", async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    await userEvent.click(within(spanRow).getByRole('button', { name: /fetch open/i }));
    await waitFor(() => expect(seenBody).toEqual({ source: 'span', scope: 'open' }));
  });

  it("clicking Full refresh sends that row's source with scope=full", async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    renderSettings();
    const mpRow = await screen.findByRole('group', { name: 'myprocurement' });
    await userEvent.click(within(mpRow).getByRole('button', { name: /full refresh/i }));
    await waitFor(() => expect(seenBody).toEqual({ source: 'myprocurement', scope: 'full' }));
  });

  it('shows a Refresh awarded results button for kwsp, not for myprocurement or span', async () => {
    renderSettings();
    const kwspRow = await screen.findByRole('group', { name: 'kwsp' });
    expect(within(kwspRow).getByRole('button', { name: /refresh awarded results/i })).toBeInTheDocument();
    const mpRow = screen.getByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
    const spanRow = screen.getByRole('group', { name: 'span' });
    expect(within(spanRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
  });

  it("clicking Refresh awarded results sends that row's source with scope=results", async () => {
    let seenBody: unknown;
    server.use(http.post('/api/scrape', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ started: true }, { status: 202 });
    }));
    renderSettings();
    const kwspRow = await screen.findByRole('group', { name: 'kwsp' });
    await userEvent.click(within(kwspRow).getByRole('button', { name: /refresh awarded results/i }));
    await waitFor(() => expect(seenBody).toEqual({ source: 'kwsp', scope: 'results' }));
  });

  it('disables Refresh awarded results while any row is running', async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    })));
    renderSettings();
    const kwspRow = await screen.findByRole('group', { name: 'kwsp' });
    expect(within(kwspRow).getByRole('button', { name: /refresh awarded results/i })).toBeDisabled();
  });

  it("shows progress and a Cancel button on the running source's row, and disables every other row's buttons", async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'running', source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
    })));
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(within(spanRow).getByText(/open-2026/)).toBeInTheDocument();
    const mpRow = screen.getByRole('group', { name: 'myprocurement' });
    expect(within(mpRow).getByRole('button', { name: /fetch open/i })).toBeDisabled();
    expect(within(mpRow).getByRole('button', { name: /full refresh/i })).toBeDisabled();
  });

  it('clicking Cancel calls the cancel endpoint', async () => {
    let cancelCalled = false;
    server.use(
      http.get('/api/scrape/status', () => HttpResponse.json({
        state: 'running', source: 'span', job: 'open-2026', jobsCompleted: 0, jobsTotal: 1, currentPage: 1, lastPage: 1,
      })),
      http.post('/api/scrape/cancel', () => { cancelCalled = true; return HttpResponse.json({ cancelled: true }); }),
    );
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    await userEvent.click(within(spanRow).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(cancelCalled).toBe(true));
  });

  it("shows a failure message on the affected source's row", async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({
      state: 'failed', source: 'span', error: 'fetch failed after 3 attempts: url',
    })));
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).getByText(/fetch failed after 3 attempts/)).toBeInTheDocument();
  });

  it("shows a cancelled message on the affected source's row", async () => {
    server.use(http.get('/api/scrape/status', () => HttpResponse.json({ state: 'cancelled', source: 'span' })));
    renderSettings();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).getByText(/cancelled/i)).toBeInTheDocument();
  });

  it('hides every rescrape/cancel/refresh button for a member', async () => {
    renderSettingsAsMember();
    const spanRow = await screen.findByRole('group', { name: 'span' });
    expect(within(spanRow).queryByRole('button', { name: /fetch open/i })).not.toBeInTheDocument();
    expect(within(spanRow).queryByRole('button', { name: /full refresh/i })).not.toBeInTheDocument();
    const kwspRow = screen.getByRole('group', { name: 'kwsp' });
    expect(within(kwspRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
  });
});
