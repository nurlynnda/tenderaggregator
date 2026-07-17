import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../auth/AuthContext';
import RegisterPage from '../pages/RegisterPage';
import { server } from './mocks';

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn().mockResolvedValue({ id: 'cred-1', response: {} }),
}));

function renderRegisterPage() {
  return render(
    <MemoryRouter initialEntries={['/register']}>
      <AuthProvider>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RegisterPage', () => {
  it('walks through details -> otp -> passkey -> home', async () => {
    server.use(
      http.post('/api/auth/register/request', () => HttpResponse.json({ ok: true }, { status: 202 })),
      http.post('/api/auth/register/verify-otp', () => HttpResponse.json({ ok: true })),
      http.post('/api/auth/register/passkey/options', () => HttpResponse.json({ challenge: 'chal' })),
      http.post('/api/auth/register/passkey/verify', () => HttpResponse.json({ user: { name: 'Jane', email: 'jane@example.com', role: 'member' } })),
    );
    renderRegisterPage();

    await userEvent.type(screen.getByLabelText(/name/i), 'Jane');
    await userEvent.type(screen.getByLabelText(/email/i), 'jane@example.com');
    await userEvent.click(screen.getByRole('button', { name: /request access/i }));

    await waitFor(() => expect(screen.getByLabelText(/code/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify code/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /create passkey/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /create passkey/i }));

    await waitFor(() => expect(screen.getByText('home')).toBeInTheDocument());
  });

  it('resets to the details step after 3 wrong OTP attempts (410)', async () => {
    server.use(
      http.post('/api/auth/register/request', () => HttpResponse.json({ ok: true }, { status: 202 })),
      http.post('/api/auth/register/verify-otp', () => HttpResponse.json({ error: 'locked' }, { status: 410 })),
    );
    renderRegisterPage();
    await userEvent.type(screen.getByLabelText(/name/i), 'Jane');
    await userEvent.type(screen.getByLabelText(/email/i), 'jane@example.com');
    await userEvent.click(screen.getByRole('button', { name: /request access/i }));

    await waitFor(() => expect(screen.getByLabelText(/code/i)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: /verify code/i }));

    await waitFor(() => expect(screen.getByLabelText(/name/i)).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/start over/i);
  });
});
