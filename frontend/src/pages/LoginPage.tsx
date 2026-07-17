import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import { getLoginOptions, verifyLogin } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const options = await getLoginOptions(email);
      const assertion = await startAuthentication({ optionsJSON: options });
      await verifyLogin(email, assertion);
      await refresh();
      navigate('/');
    } catch {
      setError('Sign in failed. Check your email or try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-24 space-y-4">
      <h1 className="font-semibold text-lg">Sign in</h1>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-sm font-medium" htmlFor="login-email">Email</label>
        <input
          id="login-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-[#e0e0e0] rounded-md px-3 py-2"
        />
        {error && <div role="alert" className="text-sm text-red-700">{error}</div>}
        <button
          type="submit"
          disabled={pending}
          className="w-full bg-blue-900 text-white text-sm rounded-md px-3 py-2 disabled:opacity-50"
        >
          Sign in with passkey
        </button>
      </form>
    </div>
  );
}
