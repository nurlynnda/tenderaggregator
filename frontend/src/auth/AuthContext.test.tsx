import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/mocks';
import { AuthProvider, useAuth } from './AuthContext';

function Probe() {
  const { user, loading, signOut } = useAuth();
  if (loading) return <div>loading</div>;
  return (
    <div>
      <div>{user ? `logged in as ${user.email}` : 'logged out'}</div>
      <button onClick={() => void signOut()}>sign out</button>
    </div>
  );
}

describe('AuthContext', () => {
  it('loads the current user on mount', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Jane', email: 'jane@example.com', role: 'member' })));
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(screen.getByText('loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('logged in as jane@example.com')).toBeInTheDocument());
  });

  it('shows logged out when /api/auth/me 401s', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ error: 'not authenticated' }, { status: 401 })));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('logged out')).toBeInTheDocument());
  });

  it('signOut clears the user', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Jane', email: 'jane@example.com', role: 'member' })));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('logged in as jane@example.com')).toBeInTheDocument());
    await userEvent.click(screen.getByText('sign out'));
    await waitFor(() => expect(screen.getByText('logged out')).toBeInTheDocument());
  });
});
