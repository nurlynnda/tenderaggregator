import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';
import LoginPage from '../pages/LoginPage';
import { server } from './mocks';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn().mockResolvedValue({ id: 'cred-1', response: {} }),
}));

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  it('signs in and navigates home on success', async () => {
    server.use(
      http.post('/api/auth/login/options', () => HttpResponse.json({ challenge: 'chal' })),
      http.post('/api/auth/login/verify', () => HttpResponse.json({ user: { name: 'Jane', email: 'jane@example.com', role: 'member' } })),
    );
    renderLoginPage();
    await userEvent.type(screen.getByLabelText(/email/i), 'jane@example.com');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText('home')).toBeInTheDocument());
  });

  it('shows an error message when the email is unknown', async () => {
    server.use(http.post('/api/auth/login/options', () => HttpResponse.json({ error: 'no account' }, { status: 404 })));
    renderLoginPage();
    await userEvent.type(screen.getByLabelText(/email/i), 'nobody@example.com');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
