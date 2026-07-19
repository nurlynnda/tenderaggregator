import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { getPasskeyRegistrationOptions, registerRequest, verifyPasskeyRegistration, verifyRegistrationOtp } from '../api/client';
import { useAuth } from '../auth/AuthContext';

type Step = 'details' | 'otp' | 'passkey';

export default function RegisterPage() {
  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  async function handleDetailsSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await registerRequest({ name, email });
      setStep('otp');
    } catch {
      setError('Could not start registration. Please try again.');
    } finally {
      setPending(false);
    }
  }

  async function handleOtpSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await verifyRegistrationOtp(otp);
      setStep('passkey');
    } catch (err) {
      const status = err instanceof Error && /\b410\b/.test(err.message) ? 410 : undefined;
      if (status === 410) {
        setError('Too many wrong attempts — please start over.');
        setStep('details');
        setOtp('');
      } else {
        setError('Wrong code, try again.');
      }
    } finally {
      setPending(false);
    }
  }

  async function handleCreatePasskey() {
    setError(null);
    setPending(true);
    try {
      const options = await getPasskeyRegistrationOptions();
      const response = await startRegistration({ optionsJSON: options });
      await verifyPasskeyRegistration(response);
      await refresh();
      navigate('/');
    } catch (err) {
      console.error('passkey registration failed:', err);
      setError('Passkey setup failed. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-24 space-y-4">
      <h1 className="font-semibold text-lg">Request access</h1>
      {error && <div role="alert" className="text-sm text-red-700">{error}</div>}

      {step === 'details' && (
        <form onSubmit={handleDetailsSubmit} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="register-name">Name</label>
          <input id="register-name" required value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-[#e0e0e0] rounded-md px-3 py-2" />
          <label className="block text-sm font-medium" htmlFor="register-email">Email</label>
          <input id="register-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full border border-[#e0e0e0] rounded-md px-3 py-2" />
          <button type="submit" disabled={pending} className="w-full bg-blue-900 text-white text-sm rounded-md px-3 py-2 disabled:opacity-50">
            Request access
          </button>
        </form>
      )}

      {step === 'otp' && (
        <form onSubmit={handleOtpSubmit} className="space-y-3">
          <p className="text-sm text-gray-600">Ask the admin for the 6-digit code they received.</p>
          <label className="block text-sm font-medium" htmlFor="register-otp">Code</label>
          <input id="register-otp" required value={otp} onChange={(e) => setOtp(e.target.value)} className="w-full border border-[#e0e0e0] rounded-md px-3 py-2" />
          <button type="submit" disabled={pending} className="w-full bg-blue-900 text-white text-sm rounded-md px-3 py-2 disabled:opacity-50">
            Verify code
          </button>
        </form>
      )}

      {step === 'passkey' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Set up a passkey to finish creating your account.</p>
          <button onClick={() => void handleCreatePasskey()} disabled={pending} className="w-full bg-blue-900 text-white text-sm rounded-md px-3 py-2 disabled:opacity-50">
            Create passkey
          </button>
        </div>
      )}
    </div>
  );
}
