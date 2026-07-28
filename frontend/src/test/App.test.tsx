import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import App from '../App';
import { server } from './mocks';

describe('App', () => {
  it('renders the heading and all three nav links', async () => {
    render(<App />);
    expect(await screen.findByText('Malaysia Tender Aggregator')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Tenders' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Closed Tenders' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Awarded Tenders' })).toBeInTheDocument();
  });

  it('redirects the root route to Open Tenders, which renders the list', async () => {
    render(<App />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
  });

  it('renders a Settings link pinned in the nav, leading to the Settings page', async () => {
    render(<App />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText('Data Sources')).toBeInTheDocument();
  });

  it('renders a Dashboard link pinned first in the nav, leading to the Dashboard page', async () => {
    render(<App />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByText('Spend by Ministry')).toBeInTheDocument();
  });

  it('renders an icon next to each nav link', async () => {
    render(<App />);
    for (const name of ['Dashboard', 'Open Tenders', 'Closed Tenders', 'Awarded Tenders', 'Settings', 'About']) {
      const link = await screen.findByRole('link', { name });
      expect(link.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    }
  });

  it('renders an About link pinned in the nav, leading to the About page', async () => {
    render(<App />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.click(screen.getByRole('link', { name: 'About' }));
    expect(await screen.findByRole('heading', { name: 'About' })).toBeInTheDocument();
  });

  it('gives the main content area a light gray background', async () => {
    render(<App />);
    expect(await screen.findByRole('main')).toHaveClass('bg-[#F8FAFC]');
  });

  it('redirects to /login when there is no session', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ error: 'not authenticated' }, { status: 401 })));
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument());
  });

  it('does not show a Manage users link for a member', async () => {
    render(<App />); // default mock handler returns role: 'member'
    await waitFor(() => expect(screen.getByText('Malaysia Tender Aggregator')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Manage users' })).not.toBeInTheDocument();
  });

  it('shows a Manage users link for an admin, leading to the admin page', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })));
    render(<App />);
    await screen.findByText('MENYELENGGARA PERALATAN MAKMAL');
    await userEvent.click(screen.getByRole('link', { name: 'Manage users' }));
    expect(await screen.findByRole('heading', { name: 'Manage users' })).toBeInTheDocument(); // once AdminUsersPage's own /api/admin/users call resolves via the default mock handler — this page renders even with an empty/default list
  });

  it('shows the signed-in user\'s email and a Log out button in the sidebar, which signs them out', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Jane', email: 'jane@example.com', role: 'member' })));
    render(<App />);
    await waitFor(() => expect(screen.getByText('jane@example.com')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getByLabelText(/email/i)).toBeInTheDocument()); // redirected to /login
  });
});
