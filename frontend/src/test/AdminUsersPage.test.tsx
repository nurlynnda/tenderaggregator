import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import AdminUsersPage from '../pages/AdminUsersPage';
import { AuthProvider } from '../auth/AuthContext';
import { server } from './mocks';

function renderPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AdminUsersPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe('AdminUsersPage', () => {
  it('lists users and can change a role', async () => {
    server.use(
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Member', email: 'member@example.com', role: 'member', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());

    let patchedBody: unknown;
    server.use(http.patch('/api/admin/users/2/role', async ({ request }) => {
      patchedBody = await request.json();
      return HttpResponse.json({ id: '2', name: 'Member', email: 'member@example.com', role: 'admin', createdAt: '2026-07-02T00:00:00.000Z' });
    }));
    await userEvent.selectOptions(screen.getByLabelText(/role for member@example.com/i), 'admin');
    await waitFor(() => expect(patchedBody).toEqual({ role: 'admin' }));
  });

  it('shows an error message when demoting the last remaining admin is rejected with 409', async () => {
    server.use(
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Member', email: 'member@example.com', role: 'member', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeInTheDocument());

    server.use(http.patch('/api/admin/users/1/role', () =>
      HttpResponse.json({ error: 'cannot demote the last remaining admin' }, { status: 409 }),
    ));
    await userEvent.selectOptions(screen.getByLabelText(/role for admin@example.com/i), 'member');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/cannot demote the last remaining admin/i));
  });

  it('removes a user when Remove is clicked and confirmed', async () => {
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })),
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Member', email: 'member@example.com', role: 'member', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let deletedId: string | undefined;
    server.use(http.delete('/api/admin/users/:id', ({ params }) => {
      deletedId = params.id as string;
      return HttpResponse.json({ ok: true });
    }));

    renderPage();
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /remove member@example\.com/i }));

    await waitFor(() => expect(deletedId).toBe('2'));
  });

  it('does not call the delete endpoint when the confirm dialog is cancelled', async () => {
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })),
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Member', email: 'member@example.com', role: 'member', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    let deleteCalled = false;
    server.use(http.delete('/api/admin/users/2', () => {
      deleteCalled = true;
      return HttpResponse.json({ ok: true });
    }));

    renderPage();
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /remove member@example\.com/i }));

    expect(deleteCalled).toBe(false);
  });

  it('shows an error message when removal is rejected with 409', async () => {
    // Note: the signed-in admin's own row never has a Remove button (see the
    // "does not show a Remove button on the signed-in admin's own row" test),
    // so this scenario is exercised against a second admin row rather than
    // the signed-in user's own row.
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })),
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Second Admin', email: 'admin2@example.com', role: 'admin', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    server.use(http.delete('/api/admin/users/2', () =>
      HttpResponse.json({ error: 'cannot remove the last remaining admin' }, { status: 409 }),
    ));

    renderPage();
    await waitFor(() => expect(screen.getByText('admin2@example.com')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /remove admin2@example\.com/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/cannot remove the last remaining admin/i));
  });

  it('does not show a Remove button on the signed-in admin\'s own row', async () => {
    server.use(
      http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })),
      http.get('/api/admin/users', () => HttpResponse.json({
        users: [
          { id: '1', name: 'Admin', email: 'admin@example.com', role: 'admin', createdAt: '2026-07-01T00:00:00.000Z' },
          { id: '2', name: 'Member', email: 'member@example.com', role: 'member', createdAt: '2026-07-02T00:00:00.000Z' },
        ],
      })),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /remove admin@example\.com/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove member@example\.com/i })).toBeInTheDocument();
  });
});
