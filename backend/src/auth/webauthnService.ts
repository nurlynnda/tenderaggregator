import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

export interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
}

export interface WebAuthnService {
  generateRegistrationOptions(params: { userId: string; email: string }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(params: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<{ verified: boolean; credential?: StoredCredential }>;
  generateAuthenticationOptions(params: { credential: StoredCredential }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(params: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: StoredCredential;
  }): Promise<{ verified: boolean; newCounter?: number }>;
}

export class SimpleWebAuthnService implements WebAuthnService {
  constructor(
    private readonly rpID: string,
    private readonly rpName: string,
    private readonly origin: string,
  ) {}

  async generateRegistrationOptions(params: { userId: string; email: string }) {
    return generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName: params.email,
      userID: new TextEncoder().encode(params.userId),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
    });
  }

  async verifyRegistration(params: { response: RegistrationResponseJSON; expectedChallenge: string }) {
    const result = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
    });
    if (!result.verified || !result.registrationInfo) return { verified: false };
    const { credential } = result.registrationInfo;
    return {
      verified: true,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports,
      },
    };
  }

  async generateAuthenticationOptions(params: { credential: StoredCredential }) {
    return generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: [{ id: params.credential.id, transports: params.credential.transports as never }],
      userVerification: 'preferred',
    });
  }

  async verifyAuthentication(params: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: StoredCredential;
  }) {
    const result = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: {
        id: params.credential.id,
        publicKey: Buffer.from(params.credential.publicKey, 'base64url'),
        counter: params.credential.counter,
      },
    });
    if (!result.verified) return { verified: false };
    return { verified: true, newCounter: result.authenticationInfo.newCounter };
  }
}

export class FakeWebAuthnService implements WebAuthnService {
  nextRegistrationResult: { verified: boolean; credential?: StoredCredential } = {
    verified: true,
    credential: { id: 'fake-cred-1', publicKey: 'fake-public-key', counter: 0 },
  };
  nextAuthenticationResult: { verified: boolean; newCounter?: number } = { verified: true, newCounter: 1 };

  async generateRegistrationOptions(params: { userId: string; email: string }) {
    return {
      challenge: 'fake-registration-challenge',
      rp: { id: 'localhost', name: 'test' },
      user: { id: params.userId, name: params.email, displayName: params.email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    } as unknown as PublicKeyCredentialCreationOptionsJSON;
  }

  async verifyRegistration() {
    return this.nextRegistrationResult;
  }

  async generateAuthenticationOptions(params: { credential: StoredCredential }) {
    return {
      challenge: 'fake-authentication-challenge',
      allowCredentials: [{ id: params.credential.id }],
    } as unknown as PublicKeyCredentialRequestOptionsJSON;
  }

  async verifyAuthentication() {
    return this.nextAuthenticationResult;
  }
}
