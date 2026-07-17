import { describe, expect, it, vi } from 'vitest';

const generateRegistrationOptions = vi.fn();
const verifyRegistrationResponse = vi.fn();
const generateAuthenticationOptions = vi.fn();
const verifyAuthenticationResponse = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
}));

const { SimpleWebAuthnService, FakeWebAuthnService } = await import('../../src/auth/webauthnService.js');

describe('SimpleWebAuthnService', () => {
  it('generateRegistrationOptions passes rpID/rpName/user through to the library', async () => {
    generateRegistrationOptions.mockResolvedValue({ challenge: 'chal' });
    const svc = new SimpleWebAuthnService('localhost', 'TMS', 'http://localhost:5173');
    const opts = await svc.generateRegistrationOptions({ userId: 'user-1', email: 'a@b.com' });
    expect(opts).toEqual({ challenge: 'chal' });
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ rpID: 'localhost', rpName: 'TMS', userName: 'a@b.com' }),
    );
  });

  it('verifyRegistration maps a verified library result to a StoredCredential', async () => {
    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
      },
    });
    const svc = new SimpleWebAuthnService('localhost', 'TMS', 'http://localhost:5173');
    const result = await svc.verifyRegistration({ response: {} as never, expectedChallenge: 'chal' });
    expect(result.verified).toBe(true);
    expect(result.credential?.id).toBe('cred-1');
    expect(result.credential?.counter).toBe(0);
  });

  it('verifyRegistration returns verified:false when the library rejects it', async () => {
    verifyRegistrationResponse.mockResolvedValue({ verified: false });
    const svc = new SimpleWebAuthnService('localhost', 'TMS', 'http://localhost:5173');
    const result = await svc.verifyRegistration({ response: {} as never, expectedChallenge: 'chal' });
    expect(result).toEqual({ verified: false });
  });

  it('verifyAuthentication maps a verified library result to newCounter', async () => {
    verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });
    const svc = new SimpleWebAuthnService('localhost', 'TMS', 'http://localhost:5173');
    const credential = { id: 'cred-1', publicKey: Buffer.from([1, 2, 3]).toString('base64url'), counter: 4 };
    const result = await svc.verifyAuthentication({ response: {} as never, expectedChallenge: 'chal', credential });
    expect(result).toEqual({ verified: true, newCounter: 5 });
  });
});

describe('FakeWebAuthnService', () => {
  it('defaults to verified results and can be overridden per test', async () => {
    const fake = new FakeWebAuthnService();
    expect((await fake.verifyRegistration()).verified).toBe(true);
    fake.nextAuthenticationResult = { verified: false };
    expect((await fake.verifyAuthentication()).verified).toBe(false);
  });
});
