import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import AdminUsersPage from '../pages/AdminUsersPage';
import { server } from './mocks';

function renderPage() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminUsersPage />
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
});
