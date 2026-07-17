# Private Passkey Login + RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the entire site behind passkey (WebAuthn) login, with admin-approved OTP-gated registration and two roles (`admin`/`member`) that gate the rescrape function to admins only.

**Architecture:** A new `backend/src/auth/` module owns three Mongo collections (`pendingRegistrations`, `users`, `sessions`) and exposes Express routers mounted in `api/app.ts`. Registration is a 4-step flow (request → verify OTP → passkey options → passkey verify) bound to the browser via an httpOnly cookie. Login is a 2-step WebAuthn ceremony scoped by email. All cross-cutting concerns (email sending, rate limiting, WebAuthn crypto) are injected interfaces so route logic is unit-testable with fakes, matching the existing `ScraperAdapter`/`QueryableCollection` DI style already in this codebase. `requireAuth`/`requireAdmin` Express middleware gate everything else.

**Tech Stack:** `@simplewebauthn/server` v13 (backend WebAuthn), `@simplewebauthn/browser` v13 (frontend WebAuthn), `cookie-parser` v1 (reading signed cookies), raw `fetch` to MailerSend's REST API (no SDK dependency, consistent with existing `politeFetch`-based fetch usage), Node's built-in `node:crypto` for OTP hashing.

## Global Constraints

- TDD non-negotiable: failing test first, minimal implementation, commit only on green (see `CLAUDE.md`).
- Tests must never make real network calls (no real MailerSend API, no real WebAuthn authenticator) — every such boundary is an injected interface with a fake in tests.
- Coverage thresholds are 80% lines/branches, enforced by vitest on `backend` and `frontend` workspaces; do not lower thresholds.
- ESM everywhere, Node 24 target, TypeScript strict mode (matches existing `tsconfig.base.json`).
- OTP: 10-minute expiry, 3 wrong guesses locks the pending registration (`410 Gone`).
- Roles are `'admin' | 'member'`; the account registered with the email matching `ADMIN_EMAIL` (case-insensitive) becomes `admin`; all others become `member`. The last remaining admin can never be demoted (`409` if attempted).
- Login is email-scoped (user types email, server challenges that user's one stored credential) — not usernameless/discoverable-credential based.
- Follow the approved spec: `docs/superpowers/specs/2026-07-17-private-passkey-login-design.md`.

---

## Task 1: OTP generation, hashing, and verification

**Files:**
- Create: `backend/src/auth/otp.ts`
- Test: `backend/test/auth/otp.test.ts`

**Interfaces:**
- Produces: `generateOtp(rand?: () => number): string` — 6-digit zero-padded numeric string.
- Produces: `hashOtp(otp: string): string` — sha256 hex digest.
- Produces: `verifyOtp(otp: string, hash: string): boolean` — timing-safe compare.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/test/auth/otp.test.ts
import { describe, expect, it } from 'vitest';
import { generateOtp, hashOtp, verifyOtp } from '../../src/auth/otp.js';

describe('otp', () => {
  it('generateOtp zero-pads to 6 digits', () => {
    expect(generateOtp(() => 0)).toBe('000000');
    expect(generateOtp(() => 42)).toBe('000042');
    expect(generateOtp(() => 999999)).toBe('999999');
  });

  it('hashOtp is deterministic and distinguishes different inputs', () => {
    expect(hashOtp('123456')).toBe(hashOtp('123456'));
    expect(hashOtp('123456')).not.toBe(hashOtp('654321'));
  });

  it('verifyOtp accepts the correct code and rejects a wrong one', () => {
    const hash = hashOtp('482913');
    expect(verifyOtp('482913', hash)).toBe(true);
    expect(verifyOtp('482914', hash)).toBe(false);
  });

  it('verifyOtp rejects malformed hashes without throwing', () => {
    expect(verifyOtp('482913', 'not-a-valid-hex-hash')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/otp.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/otp.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/auth/otp.ts
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export function generateOtp(rand: () => number = () => randomInt(0, 1_000_000)): string {
  return String(rand()).padStart(6, '0');
}

export function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

export function verifyOtp(otp: string, hash: string): boolean {
  const candidate = Buffer.from(hashOtp(otp), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(hash, 'hex');
  } catch {
    return false;
  }
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/otp.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/otp.ts backend/test/auth/otp.test.ts
git commit -m "feat: add OTP generation, hashing, and verification"
```

---

## Task 2: In-memory rate limiter

**Files:**
- Create: `backend/src/auth/rateLimiter.ts`
- Test: `backend/test/auth/rateLimiter.test.ts`

**Interfaces:**
- Produces: `interface RateLimiter { consume(key: string, opts: { limit: number; windowMs: number }): boolean }` — returns `true` if allowed (and records the hit), `false` if throttled (does not record beyond the window).
- Produces: `class InMemoryRateLimiter implements RateLimiter` — constructor takes an optional `now: () => number` clock, defaulting to `Date.now`.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/test/auth/rateLimiter.test.ts
import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from '../../src/auth/rateLimiter.js';

describe('InMemoryRateLimiter', () => {
  it('allows up to the limit within the window, then blocks', () => {
    const limiter = new InMemoryRateLimiter(() => 1000);
    expect(limiter.consume('k', { limit: 2, windowMs: 1000 })).toBe(true);
    expect(limiter.consume('k', { limit: 2, windowMs: 1000 })).toBe(true);
    expect(limiter.consume('k', { limit: 2, windowMs: 1000 })).toBe(false);
  });

  it('allows again once the window has slid past old hits', () => {
    let t = 0;
    const limiter = new InMemoryRateLimiter(() => t);
    expect(limiter.consume('k', { limit: 1, windowMs: 1000 })).toBe(true);
    expect(limiter.consume('k', { limit: 1, windowMs: 1000 })).toBe(false);
    t = 1500;
    expect(limiter.consume('k', { limit: 1, windowMs: 1000 })).toBe(true);
  });

  it('tracks separate keys independently', () => {
    const limiter = new InMemoryRateLimiter(() => 0);
    expect(limiter.consume('a', { limit: 1, windowMs: 1000 })).toBe(true);
    expect(limiter.consume('b', { limit: 1, windowMs: 1000 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/rateLimiter.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/rateLimiter.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/auth/rateLimiter.ts
export interface RateLimiter {
  consume(key: string, opts: { limit: number; windowMs: number }): boolean;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  consume(key: string, opts: { limit: number; windowMs: number }): boolean {
    const t = this.now();
    const windowStart = t - opts.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > windowStart);
    if (recent.length >= opts.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/rateLimiter.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/rateLimiter.ts backend/test/auth/rateLimiter.test.ts
git commit -m "feat: add in-memory sliding-window rate limiter"
```

---

## Task 3: Email sender (MailerSend + fake)

**Files:**
- Create: `backend/src/auth/emailSender.ts`
- Test: `backend/test/auth/emailSender.test.ts`

**Interfaces:**
- Produces: `interface EmailSender { send(params: { to: string; subject: string; text: string }): Promise<void> }`
- Produces: `class MailerSendEmailSender implements EmailSender` — constructor `(apiKey: string, fromEmail: string, fetchImpl?: typeof fetch)`.
- Produces: `class FakeEmailSender implements EmailSender` — records sent messages in `sent: Array<{ to: string; subject: string; text: string }>`.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/test/auth/emailSender.test.ts
import { describe, expect, it, vi } from 'vitest';
import { FakeEmailSender, MailerSendEmailSender } from '../../src/auth/emailSender.js';

describe('MailerSendEmailSender', () => {
  it('POSTs to the MailerSend API with the right auth header and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const sender = new MailerSendEmailSender('secret-key', 'noreply@example.com', fetchImpl as unknown as typeof fetch);
    await sender.send({ to: 'admin@example.com', subject: 'New registration OTP', text: 'code: 123456' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.mailersend.com/v1/email',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      from: { email: 'noreply@example.com' },
      to: [{ email: 'admin@example.com' }],
      subject: 'New registration OTP',
      text: 'code: 123456',
    });
  });

  it('throws when MailerSend responds with a non-ok status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const sender = new MailerSendEmailSender('bad-key', 'noreply@example.com', fetchImpl as unknown as typeof fetch);
    await expect(sender.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow('MailerSend request failed: 401');
  });
});

describe('FakeEmailSender', () => {
  it('records sent messages instead of making a network call', async () => {
    const sender = new FakeEmailSender();
    await sender.send({ to: 'a@b.com', subject: 's', text: 't' });
    expect(sender.sent).toEqual([{ to: 'a@b.com', subject: 's', text: 't' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/emailSender.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/emailSender.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/auth/emailSender.ts
export interface EmailSender {
  send(params: { to: string; subject: string; text: string }): Promise<void>;
}

export class MailerSendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(params: { to: string; subject: string; text: string }): Promise<void> {
    const res = await this.fetchImpl('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: { email: this.fromEmail },
        to: [{ email: params.to }],
        subject: params.subject,
        text: params.text,
      }),
    });
    if (!res.ok) throw new Error(`MailerSend request failed: ${res.status}`);
  }
}

export class FakeEmailSender implements EmailSender {
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];

  async send(params: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(params);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/emailSender.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/emailSender.ts backend/test/auth/emailSender.test.ts
git commit -m "feat: add MailerSend email sender with injectable fetch and a test fake"
```

---

## Task 4: WebAuthn service (real + fake)

**Files:**
- Modify: `backend/package.json` (add `@simplewebauthn/server` dependency)
- Create: `backend/src/auth/webauthnService.ts`
- Test: `backend/test/auth/webauthnService.test.ts`

**Interfaces:**
- Produces: `interface StoredCredential { id: string; publicKey: string; counter: number; transports?: string[] }`
- Produces:
  ```typescript
  interface WebAuthnService {
    generateRegistrationOptions(params: { userId: string; email: string }): Promise<PublicKeyCredentialCreationOptionsJSON>;
    verifyRegistration(params: { response: RegistrationResponseJSON; expectedChallenge: string }): Promise<{ verified: boolean; credential?: StoredCredential }>;
    generateAuthenticationOptions(params: { credential: StoredCredential }): Promise<PublicKeyCredentialRequestOptionsJSON>;
    verifyAuthentication(params: { response: AuthenticationResponseJSON; expectedChallenge: string; credential: StoredCredential }): Promise<{ verified: boolean; newCounter?: number }>;
  }
  ```
- Produces: `class SimpleWebAuthnService implements WebAuthnService` — constructor `(rpID: string, rpName: string, origin: string)`.
- Produces: `class FakeWebAuthnService implements WebAuthnService` — public mutable fields `nextRegistrationResult` and `nextAuthenticationResult` that tests set before calling routes, plus deterministic option generators.

- [ ] **Step 1: Add the dependency**

```bash
npm install @simplewebauthn/server@^13.3.2 -w backend
```

- [ ] **Step 2: Write the failing test**

```typescript
// backend/test/auth/webauthnService.test.ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/webauthnService.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/webauthnService.js'"

- [ ] **Step 4: Write minimal implementation**

```typescript
// backend/src/auth/webauthnService.ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/webauthnService.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/auth/webauthnService.ts backend/test/auth/webauthnService.test.ts
git commit -m "feat: add WebAuthn service wrapping @simplewebauthn/server, with a test fake"
```

---

## Task 5: Auth document types and Mongo repositories

**Files:**
- Create: `backend/src/auth/types.ts`
- Create: `backend/src/auth/pendingRegistrationRepository.ts`
- Create: `backend/src/auth/userRepository.ts`
- Create: `backend/src/auth/sessionRepository.ts`
- Test: `backend/test/auth/pendingRegistrationRepository.test.ts`
- Test: `backend/test/auth/userRepository.test.ts`
- Test: `backend/test/auth/sessionRepository.test.ts`

**Interfaces:**
- Consumes: `QueryableCollection<T>` and `FakeCollection<T extends { _id: string }>` from `backend/src/storage/tenderDoc.js` and `backend/test/support/fakeMongoCollection.js` respectively (both already exist).
- Produces (`types.ts`):
  ```typescript
  export type Role = 'admin' | 'member';
  export interface PendingRegistrationDoc {
    _id: string; name: string; email: string; otpHash: string; otpAttempts: number;
    expiresAt: string; verified: boolean; challenge?: string;
  }
  export interface UserDoc {
    _id: string; name: string; email: string; role: Role;
    credential: { id: string; publicKey: string; counter: number; transports?: string[] };
    createdAt: string;
  }
  export interface SessionDoc { _id: string; userId: string; createdAt: string; expiresAt: string; }
  ```
- Produces (`pendingRegistrationRepository.ts`): `class PendingRegistrationRepository` with `create(input: { name: string; email: string; otpHash: string; expiresAt: string }): Promise<PendingRegistrationDoc>`, `findById(id: string): Promise<PendingRegistrationDoc | null>`, `incrementAttempts(id: string): Promise<number>`, `markVerified(id: string): Promise<void>`, `setChallenge(id: string, challenge: string): Promise<void>`, `delete(id: string): Promise<void>`.
- Produces (`userRepository.ts`): `class UserRepository` with `create(input: { name: string; email: string; role: Role; credential: UserDoc['credential'] }): Promise<UserDoc>`, `findByEmail(email: string): Promise<UserDoc | null>`, `findById(id: string): Promise<UserDoc | null>`, `findAll(): Promise<UserDoc[]>`, `countByRole(role: Role): Promise<number>`, `updateRole(id: string, role: Role): Promise<void>`, `updateCredentialCounter(id: string, counter: number): Promise<void>`.
- Produces (`sessionRepository.ts`): `class SessionRepository` with `create(userId: string, ttlMs: number): Promise<SessionDoc>`, `findById(id: string): Promise<SessionDoc | null>`, `touch(id: string, ttlMs: number): Promise<void>`, `delete(id: string): Promise<void>`.

- [ ] **Step 1: Write the doc types (no test needed — pure types)**

```typescript
// backend/src/auth/types.ts
export type Role = 'admin' | 'member';

export interface PendingRegistrationDoc {
  _id: string;
  name: string;
  email: string;
  otpHash: string;
  otpAttempts: number;
  expiresAt: string;
  verified: boolean;
  challenge?: string;
}

export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  role: Role;
  credential: { id: string; publicKey: string; counter: number; transports?: string[] };
  createdAt: string;
}

export interface SessionDoc {
  _id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}
```

- [ ] **Step 2: Write the failing test for PendingRegistrationRepository**

```typescript
// backend/test/auth/pendingRegistrationRepository.test.ts
import { describe, expect, it } from 'vitest';
import { PendingRegistrationRepository } from '../../src/auth/pendingRegistrationRepository.js';
import type { PendingRegistrationDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

describe('PendingRegistrationRepository', () => {
  it('creates a record with zero attempts and unverified, and can find it by id', async () => {
    const repo = new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>());
    const created = await repo.create({ name: 'Jane', email: 'jane@example.com', otpHash: 'hash1', expiresAt: '2026-07-17T10:10:00.000Z' });
    expect(created.otpAttempts).toBe(0);
    expect(created.verified).toBe(false);

    const found = await repo.findById(created._id);
    expect(found).toEqual(created);
  });

  it('findById returns null for an unknown id', async () => {
    const repo = new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>());
    expect(await repo.findById('nope')).toBeNull();
  });

  it('incrementAttempts returns the new count', async () => {
    const repo = new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>());
    const created = await repo.create({ name: 'Jane', email: 'jane@example.com', otpHash: 'hash1', expiresAt: '2026-07-17T10:10:00.000Z' });
    expect(await repo.incrementAttempts(created._id)).toBe(1);
    expect(await repo.incrementAttempts(created._id)).toBe(2);
  });

  it('markVerified and setChallenge update the record', async () => {
    const repo = new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>());
    const created = await repo.create({ name: 'Jane', email: 'jane@example.com', otpHash: 'hash1', expiresAt: '2026-07-17T10:10:00.000Z' });
    await repo.markVerified(created._id);
    await repo.setChallenge(created._id, 'chal-1');
    const found = await repo.findById(created._id);
    expect(found?.verified).toBe(true);
    expect(found?.challenge).toBe('chal-1');
  });

  it('delete removes the record', async () => {
    const repo = new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>());
    const created = await repo.create({ name: 'Jane', email: 'jane@example.com', otpHash: 'hash1', expiresAt: '2026-07-17T10:10:00.000Z' });
    await repo.delete(created._id);
    expect(await repo.findById(created._id)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/pendingRegistrationRepository.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/pendingRegistrationRepository.js'"

- [ ] **Step 4: Write minimal implementation**

```typescript
// backend/src/auth/pendingRegistrationRepository.ts
import { randomUUID } from 'node:crypto';
import type { QueryableCollection } from '../storage/tenderDoc.js';
import type { PendingRegistrationDoc } from './types.js';

export class PendingRegistrationRepository {
  constructor(private readonly collection: QueryableCollection<PendingRegistrationDoc>) {}

  async create(input: { name: string; email: string; otpHash: string; expiresAt: string }): Promise<PendingRegistrationDoc> {
    const doc: PendingRegistrationDoc = {
      _id: randomUUID(),
      name: input.name,
      email: input.email,
      otpHash: input.otpHash,
      otpAttempts: 0,
      expiresAt: input.expiresAt,
      verified: false,
    };
    await this.collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
    return doc;
  }

  async findById(id: string): Promise<PendingRegistrationDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  async incrementAttempts(id: string): Promise<number> {
    const doc = await this.findById(id);
    if (!doc) throw new Error(`pending registration not found: ${id}`);
    const updated = { ...doc, otpAttempts: doc.otpAttempts + 1 };
    await this.collection.replaceOne({ _id: id }, updated);
    return updated.otpAttempts;
  }

  async markVerified(id: string): Promise<void> {
    const doc = await this.findById(id);
    if (!doc) throw new Error(`pending registration not found: ${id}`);
    await this.collection.replaceOne({ _id: id }, { ...doc, verified: true });
  }

  async setChallenge(id: string, challenge: string): Promise<void> {
    const doc = await this.findById(id);
    if (!doc) throw new Error(`pending registration not found: ${id}`);
    await this.collection.replaceOne({ _id: id }, { ...doc, challenge });
  }

  async delete(id: string): Promise<void> {
    await this.collection.replaceOne({ _id: id }, { _id: id } as PendingRegistrationDoc);
    // FakeCollection/Mongo both lack a shared deleteOne in QueryableCollection; deletion is
    // simulated by the caller checking `expiresAt`/absence via updateMany filtering it out on
    // read paths is unnecessary here because routes only ever look up by id right after — so
    // truly remove the doc instead of tombstoning it.
  }
}
```

**Note for implementer:** `QueryableCollection` (in `backend/src/storage/tenderDoc.ts`) has no `deleteOne`. Before writing Step 4 for real, check whether `QueryableCollection` needs a `deleteOne(filter): Promise<unknown>` method added — it does, because `pendingRegistrations` and `sessions` both need true deletion (a stale placeholder doc would fail `findById` returning non-null when it should return null, and would break the "delete removes the record" test above). Do the following instead of the placeholder shown:
1. Add `deleteOne(filter: Record<string, unknown>): Promise<unknown>;` to the `QueryableCollection<T>` interface in `backend/src/storage/tenderDoc.ts`.
2. Add a matching `async deleteOne(filter: Filter): Promise<{ deletedCount: number }>` method to `FakeCollection` in `backend/test/support/fakeMongoCollection.ts` (removes the first matching doc from the internal `Map`, mirroring `findOne`'s matching logic; mongodb's real `Collection` already implements `deleteOne` natively, so no change is needed there).
3. Implement `PendingRegistrationRepository.delete` as `await this.collection.deleteOne({ _id: id });`.

Re-run the fakeMongoCollection test suite after step 2 (`npm run test -w backend -- test/support/fakeMongoCollection.test.ts`) to confirm nothing broke, and add one `deleteOne` case there:

```typescript
// append to backend/test/support/fakeMongoCollection.test.ts
it('deleteOne removes a matching document', async () => {
  const col = new FakeCollection<{ _id: string; name: string }>();
  await col.replaceOne({ _id: '1' }, { _id: '1', name: 'a' }, { upsert: true });
  await col.deleteOne({ _id: '1' });
  expect(await col.findOne({ _id: '1' })).toBeNull();
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/pendingRegistrationRepository.test.ts test/support/fakeMongoCollection.test.ts`
Expected: PASS (all tests, including the new `deleteOne` case)

- [ ] **Step 6: Commit**

```bash
git add backend/src/auth/types.ts backend/src/auth/pendingRegistrationRepository.ts backend/src/storage/tenderDoc.ts backend/test/auth/pendingRegistrationRepository.test.ts backend/test/support/fakeMongoCollection.ts backend/test/support/fakeMongoCollection.test.ts
git commit -m "feat: add PendingRegistrationRepository and QueryableCollection.deleteOne"
```

- [ ] **Step 7: Write the failing test for UserRepository**

```typescript
// backend/test/auth/userRepository.test.ts
import { describe, expect, it } from 'vitest';
import { UserRepository } from '../../src/auth/userRepository.js';
import type { UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

const credential = { id: 'cred-1', publicKey: 'pk', counter: 0 };

describe('UserRepository', () => {
  it('creates a user and finds it by email (case-insensitive) and by id', async () => {
    const repo = new UserRepository(new FakeCollection<UserDoc>());
    const created = await repo.create({ name: 'Jane', email: 'Jane@Example.com', role: 'member', credential });
    expect(await repo.findByEmail('jane@example.com')).toEqual(created);
    expect(await repo.findById(created._id)).toEqual(created);
  });

  it('findByEmail returns null when no user matches', async () => {
    const repo = new UserRepository(new FakeCollection<UserDoc>());
    expect(await repo.findByEmail('nobody@example.com')).toBeNull();
  });

  it('findAll lists every user', async () => {
    const repo = new UserRepository(new FakeCollection<UserDoc>());
    await repo.create({ name: 'A', email: 'a@example.com', role: 'admin', credential });
    await repo.create({ name: 'B', email: 'b@example.com', role: 'member', credential });
    expect((await repo.findAll()).map((u) => u.email).sort()).toEqual(['a@example.com', 'b@example.com']);
  });

  it('countByRole counts only that role', async () => {
    const repo = new UserRepository(new FakeCollection<UserDoc>());
    await repo.create({ name: 'A', email: 'a@example.com', role: 'admin', credential });
    await repo.create({ name: 'B', email: 'b@example.com', role: 'member', credential });
    expect(await repo.countByRole('admin')).toBe(1);
    expect(await repo.countByRole('member')).toBe(1);
  });

  it('updateRole changes a user\'s role', async () => {
    const repo = new UserRepository(new FakeCollection<UserDoc>());
    const created = await repo.create({ name: 'A', email: 'a@example.com', role: 'member', credential });
    await repo.updateRole(created._id, 'admin');
    expect((await repo.findById(created._id))?.role).toBe('admin');
  });

  it('updateCredentialCounter changes the stored counter', async () => {
    const repo = new UserRepository(new FakeCollection<UserDoc>());
    const created = await repo.create({ name: 'A', email: 'a@example.com', role: 'member', credential });
    await repo.updateCredentialCounter(created._id, 7);
    expect((await repo.findById(created._id))?.credential.counter).toBe(7);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/userRepository.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/userRepository.js'"

- [ ] **Step 9: Write minimal implementation**

```typescript
// backend/src/auth/userRepository.ts
import { randomUUID } from 'node:crypto';
import type { QueryableCollection } from '../storage/tenderDoc.js';
import type { Role, UserDoc } from './types.js';

export class UserRepository {
  constructor(private readonly collection: QueryableCollection<UserDoc>) {}

  async create(input: { name: string; email: string; role: Role; credential: UserDoc['credential'] }): Promise<UserDoc> {
    const doc: UserDoc = {
      _id: randomUUID(),
      name: input.name,
      email: input.email.toLowerCase(),
      role: input.role,
      credential: input.credential,
      createdAt: new Date().toISOString(),
    };
    await this.collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
    return doc;
  }

  async findByEmail(email: string): Promise<UserDoc | null> {
    return this.collection.findOne({ email: email.toLowerCase() });
  }

  async findById(id: string): Promise<UserDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  async findAll(): Promise<UserDoc[]> {
    return this.collection.find({}).toArray();
  }

  async countByRole(role: Role): Promise<number> {
    return this.collection.countDocuments({ role });
  }

  async updateRole(id: string, role: Role): Promise<void> {
    const doc = await this.findById(id);
    if (!doc) throw new Error(`user not found: ${id}`);
    await this.collection.replaceOne({ _id: id }, { ...doc, role });
  }

  async updateCredentialCounter(id: string, counter: number): Promise<void> {
    const doc = await this.findById(id);
    if (!doc) throw new Error(`user not found: ${id}`);
    await this.collection.replaceOne({ _id: id }, { ...doc, credential: { ...doc.credential, counter } });
  }
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/userRepository.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 11: Commit**

```bash
git add backend/src/auth/userRepository.ts backend/test/auth/userRepository.test.ts
git commit -m "feat: add UserRepository"
```

- [ ] **Step 12: Write the failing test for SessionRepository**

```typescript
// backend/test/auth/sessionRepository.test.ts
import { describe, expect, it } from 'vitest';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import type { SessionDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

describe('SessionRepository', () => {
  it('creates a session with an expiresAt ttlMs in the future', async () => {
    const repo = new SessionRepository(new FakeCollection<SessionDoc>(), () => new Date('2026-07-17T00:00:00.000Z'));
    const session = await repo.create('user-1', 1000 * 60 * 60 * 24 * 30);
    expect(session.userId).toBe('user-1');
    expect(session.expiresAt).toBe('2026-08-16T00:00:00.000Z');
  });

  it('findById returns the session, or null when unknown', async () => {
    const repo = new SessionRepository(new FakeCollection<SessionDoc>(), () => new Date('2026-07-17T00:00:00.000Z'));
    const session = await repo.create('user-1', 1000);
    expect(await repo.findById(session._id)).toEqual(session);
    expect(await repo.findById('nope')).toBeNull();
  });

  it('touch extends expiresAt from the current clock time', async () => {
    let now = new Date('2026-07-17T00:00:00.000Z');
    const repo = new SessionRepository(new FakeCollection<SessionDoc>(), () => now);
    const session = await repo.create('user-1', 1000 * 60);
    now = new Date('2026-07-17T00:30:00.000Z');
    await repo.touch(session._id, 1000 * 60);
    const updated = await repo.findById(session._id);
    expect(updated?.expiresAt).toBe('2026-07-17T00:31:00.000Z');
  });

  it('delete removes the session', async () => {
    const repo = new SessionRepository(new FakeCollection<SessionDoc>(), () => new Date('2026-07-17T00:00:00.000Z'));
    const session = await repo.create('user-1', 1000);
    await repo.delete(session._id);
    expect(await repo.findById(session._id)).toBeNull();
  });
});
```

- [ ] **Step 13: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/sessionRepository.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/sessionRepository.js'"

- [ ] **Step 14: Write minimal implementation**

```typescript
// backend/src/auth/sessionRepository.ts
import { randomUUID } from 'node:crypto';
import type { QueryableCollection } from '../storage/tenderDoc.js';
import type { SessionDoc } from './types.js';

export class SessionRepository {
  constructor(
    private readonly collection: QueryableCollection<SessionDoc>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(userId: string, ttlMs: number): Promise<SessionDoc> {
    const created = this.now();
    const doc: SessionDoc = {
      _id: randomUUID(),
      userId,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
    };
    await this.collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
    return doc;
  }

  async findById(id: string): Promise<SessionDoc | null> {
    return this.collection.findOne({ _id: id });
  }

  async touch(id: string, ttlMs: number): Promise<void> {
    const doc = await this.findById(id);
    if (!doc) return;
    await this.collection.replaceOne({ _id: id }, { ...doc, expiresAt: new Date(this.now().getTime() + ttlMs).toISOString() });
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
  }
}
```

- [ ] **Step 15: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/sessionRepository.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 16: Commit**

```bash
git add backend/src/auth/sessionRepository.ts backend/test/auth/sessionRepository.test.ts
git commit -m "feat: add SessionRepository"
```

---

## Task 6: Signed auth cookies

**Files:**
- Modify: `backend/package.json` (add `cookie-parser` + `@types/cookie-parser`)
- Create: `backend/src/auth/cookies.ts`
- Test: `backend/test/auth/cookies.test.ts`

**Interfaces:**
- Consumes: Express `Request`/`Response` (via `cookie-parser`'s signed-cookie support, so `req.signedCookies` is populated when `cookieParser(secret)` is used as middleware).
- Produces:
  ```typescript
  export const PENDING_REG_COOKIE = 'pendingRegId';
  export const SESSION_COOKIE = 'sessionId';
  export function setPendingRegCookie(res: Response, id: string): void;
  export function readPendingRegCookie(req: Request): string | undefined;
  export function clearPendingRegCookie(res: Response): void;
  export function setSessionCookie(res: Response, id: string, ttlMs: number): void;
  export function readSessionCookie(req: Request): string | undefined;
  export function clearSessionCookie(res: Response): void;
  ```

- [ ] **Step 1: Add dependencies**

```bash
npm install cookie-parser@^1.4.7 -w backend
npm install --save-dev @types/cookie-parser@^1.4.10 -w backend
```

- [ ] **Step 2: Write the failing test**

```typescript
// backend/test/auth/cookies.test.ts
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  clearPendingRegCookie,
  clearSessionCookie,
  PENDING_REG_COOKIE,
  readPendingRegCookie,
  readSessionCookie,
  SESSION_COOKIE,
  setPendingRegCookie,
  setSessionCookie,
} from '../../src/auth/cookies.js';

function buildApp() {
  const app = express();
  app.use(cookieParser('test-secret'));
  app.get('/set-pending', (_req, res) => {
    setPendingRegCookie(res, 'pending-123');
    res.json({ ok: true });
  });
  app.get('/read-pending', (req, res) => res.json({ id: readPendingRegCookie(req) ?? null }));
  app.get('/clear-pending', (_req, res) => {
    clearPendingRegCookie(res);
    res.json({ ok: true });
  });
  app.get('/set-session', (_req, res) => {
    setSessionCookie(res, 'session-123', 1000 * 60);
    res.json({ ok: true });
  });
  app.get('/read-session', (req, res) => res.json({ id: readSessionCookie(req) ?? null }));
  app.get('/clear-session', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  return app;
}

describe('auth cookies', () => {
  it('round-trips the pending registration cookie through a signed cookie jar', async () => {
    const app = buildApp();
    const agent = request.agent(app);
    await agent.get('/set-pending');
    const read = await agent.get('/read-pending');
    expect(read.body.id).toBe('pending-123');
    await agent.get('/clear-pending');
    const afterClear = await agent.get('/read-pending');
    expect(afterClear.body.id).toBeNull();
  });

  it('round-trips the session cookie through a signed cookie jar', async () => {
    const app = buildApp();
    const agent = request.agent(app);
    await agent.get('/set-session');
    const read = await agent.get('/read-session');
    expect(read.body.id).toBe('session-123');
    await agent.get('/clear-session');
    const afterClear = await agent.get('/read-session');
    expect(afterClear.body.id).toBeNull();
  });

  it('readPendingRegCookie returns undefined when no cookie is present', async () => {
    const app = buildApp();
    const res = await request(app).get('/read-pending');
    expect(res.body.id).toBeNull();
  });

  it('cookie names are exported constants', () => {
    expect(PENDING_REG_COOKIE).toBe('pendingRegId');
    expect(SESSION_COOKIE).toBe('sessionId');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/cookies.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/cookies.js'"

- [ ] **Step 4: Write minimal implementation**

```typescript
// backend/src/auth/cookies.ts
import type { Request, Response } from 'express';

export const PENDING_REG_COOKIE = 'pendingRegId';
export const SESSION_COOKIE = 'sessionId';

// 10 minutes — matches the OTP expiry window this cookie exists to bound.
const PENDING_REG_TTL_MS = 10 * 60 * 1000;

export function setPendingRegCookie(res: Response, id: string): void {
  res.cookie(PENDING_REG_COOKIE, id, {
    httpOnly: true,
    signed: true,
    sameSite: 'strict',
    maxAge: PENDING_REG_TTL_MS,
  });
}

export function readPendingRegCookie(req: Request): string | undefined {
  const value = req.signedCookies?.[PENDING_REG_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

export function clearPendingRegCookie(res: Response): void {
  res.clearCookie(PENDING_REG_COOKIE);
}

export function setSessionCookie(res: Response, id: string, ttlMs: number): void {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    signed: true,
    sameSite: 'strict',
    maxAge: ttlMs,
  });
}

export function readSessionCookie(req: Request): string | undefined {
  const value = req.signedCookies?.[SESSION_COOKIE];
  return typeof value === 'string' ? value : undefined;
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/cookies.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/auth/cookies.ts backend/test/auth/cookies.test.ts
git commit -m "feat: add signed httpOnly cookie helpers for pending registration and session"
```

---

## Task 7: requireAuth / requireAdmin middleware

**Files:**
- Create: `backend/src/auth/middleware.ts`
- Test: `backend/test/auth/middleware.test.ts`

**Interfaces:**
- Consumes: `SessionRepository`, `UserRepository` (Task 5), `readSessionCookie` (Task 6).
- Produces:
  ```typescript
  export interface AuthedRequest extends Request { user?: UserDoc }
  export function requireAuth(sessions: SessionRepository, users: UserRepository, sessionTtlMs: number): RequestHandler;
  export function requireAdmin(): RequestHandler; // used AFTER requireAuth in the middleware chain
  ```
  `requireAuth` looks up the session by cookie, loads the user, attaches it to `req.user`, and calls `sessions.touch(...)` to slide the expiry. `requireAdmin` assumes `req.user` is already set (by a preceding `requireAuth`) and 403s if `req.user.role !== 'admin'`.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/test/auth/middleware.test.ts
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { setSessionCookie } from '../../src/auth/cookies.js';
import { requireAdmin, requireAuth } from '../../src/auth/middleware.js';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import { UserRepository } from '../../src/auth/userRepository.js';
import type { SessionDoc, UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

const credential = { id: 'cred-1', publicKey: 'pk', counter: 0 };

describe('requireAuth / requireAdmin', () => {
  let sessions: SessionRepository;
  let users: UserRepository;
  let app: ReturnType<typeof express>;

  beforeEach(() => {
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    users = new UserRepository(new FakeCollection<UserDoc>());
    app = express();
    app.use(cookieParser('test-secret'));
  });

  it('401s when there is no session cookie', async () => {
    app.get('/protected', requireAuth(sessions, users, 1000), (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('401s when the session cookie references an unknown session', async () => {
    app.get('/set-bad-cookie', (_req, res) => {
      setSessionCookie(res, 'unknown-session', 1000);
      res.json({ ok: true });
    });
    app.get('/protected', requireAuth(sessions, users, 1000), (_req, res) => res.json({ ok: true }));
    const agent = request.agent(app);
    await agent.get('/set-bad-cookie');
    const res = await agent.get('/protected');
    expect(res.status).toBe(401);
  });

  it('attaches req.user and allows the request through for a valid session', async () => {
    const user = await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    const session = await sessions.create(user._id, 1000);
    app.get('/set-cookie', (_req, res) => {
      setSessionCookie(res, session._id, 1000);
      res.json({ ok: true });
    });
    app.get('/protected', requireAuth(sessions, users, 1000), (req: express.Request & { user?: UserDoc }, res) =>
      res.json({ email: req.user?.email }));
    const agent = request.agent(app);
    await agent.get('/set-cookie');
    const res = await agent.get('/protected');
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('jane@example.com');
  });

  it('requireAdmin lets an admin through and 403s a member', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const member = await users.create({ name: 'Member', email: 'member@example.com', role: 'member', credential });
    const adminSession = await sessions.create(admin._id, 1000);
    const memberSession = await sessions.create(member._id, 1000);

    app.get('/set-cookie/:id', (req, res) => {
      setSessionCookie(res, req.params.id, 1000);
      res.json({ ok: true });
    });
    app.get('/admin-only', requireAuth(sessions, users, 1000), requireAdmin(), (_req, res) => res.json({ ok: true }));

    const adminAgent = request.agent(app);
    await adminAgent.get(`/set-cookie/${adminSession._id}`);
    expect((await adminAgent.get('/admin-only')).status).toBe(200);

    const memberAgent = request.agent(app);
    await memberAgent.get(`/set-cookie/${memberSession._id}`);
    expect((await memberAgent.get('/admin-only')).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/middleware.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/middleware.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/auth/middleware.ts
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { readSessionCookie } from './cookies.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserDoc } from './types.js';
import type { UserRepository } from './userRepository.js';

export interface AuthedRequest extends Request {
  user?: UserDoc;
}

export function requireAuth(sessions: SessionRepository, users: UserRepository, sessionTtlMs: number): RequestHandler {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const sessionId = readSessionCookie(req);
    if (!sessionId) return res.status(401).json({ error: 'not authenticated' });

    const session = await sessions.findById(sessionId);
    if (!session) return res.status(401).json({ error: 'not authenticated' });

    const user = await users.findById(session.userId);
    if (!user) return res.status(401).json({ error: 'not authenticated' });

    await sessions.touch(sessionId, sessionTtlMs);
    req.user = user;
    next();
  };
}

export function requireAdmin(): RequestHandler {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/middleware.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/middleware.ts backend/test/auth/middleware.test.ts
git commit -m "feat: add requireAuth and requireAdmin Express middleware"
```

---

## Task 8: Registration routes

**Files:**
- Create: `backend/src/auth/registerRoutes.ts`
- Test: `backend/test/auth/registerRoutes.test.ts`

**Interfaces:**
- Consumes: `PendingRegistrationRepository`, `UserRepository` (Task 5), `EmailSender` (Task 3), `WebAuthnService` (Task 4), `RateLimiter` (Task 2), `generateOtp`/`hashOtp`/`verifyOtp` (Task 1), cookie helpers (Task 6).
- Produces: `function createRegisterRoutes(deps: { pendingRegistrations: PendingRegistrationRepository; users: UserRepository; email: EmailSender; webauthn: WebAuthnService; rateLimiter: RateLimiter; adminEmail: string; sessions: SessionRepository; sessionTtlMs: number; now?: () => Date }): Router` mounted at `/api/auth/register`, exposing `POST /request`, `POST /verify-otp`, `POST /passkey/options`, `POST /passkey/verify`.

Route bodies (validated with `zod`, matching the existing `QuerySchema`/`ScrapeRequestSchema` style in `backend/src/api/app.ts`):
- `POST /request { name, email }` → `429` if `rateLimiter.consume('register:' + req.ip, { limit: 3, windowMs: 3_600_000 })` is `false`; otherwise generates OTP, stores hashed pending registration (10 min expiry from `now()`), sets pending-reg cookie, emails `adminEmail` via `email.send(...)`, responds `202 { ok: true }`.
- `POST /verify-otp { otp }` → reads pending-reg cookie (`400` if missing/unknown/expired), compares via `verifyOtp`; on mismatch increments attempts and returns `400` unless the 3rd wrong guess, which deletes the record, clears the cookie, and returns `410`; on match calls `markVerified` and returns `200 { ok: true }`.
- `POST /passkey/options` → `400` if pending registration missing/not verified; generates WebAuthn registration options via `webauthn.generateRegistrationOptions({ userId: pending._id, email: pending.email })`, stores the challenge, returns the options JSON.
- `POST /passkey/verify { response }` → `400` if pending registration missing/not verified/no stored challenge; calls `webauthn.verifyRegistration({ response, expectedChallenge })`; on failure returns `400`; on success creates the user (role = `admin` if `pending.email.toLowerCase() === adminEmail.toLowerCase()` else `member`), deletes the pending registration, clears its cookie, creates a session, sets the session cookie, responds `200 { user: { name, email, role } }`.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/test/auth/registerRoutes.test.ts
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRegisterRoutes } from '../../src/auth/registerRoutes.js';
import { PendingRegistrationRepository } from '../../src/auth/pendingRegistrationRepository.js';
import { UserRepository } from '../../src/auth/userRepository.js';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import { FakeEmailSender } from '../../src/auth/emailSender.js';
import { FakeWebAuthnService } from '../../src/auth/webauthnService.js';
import { InMemoryRateLimiter } from '../../src/auth/rateLimiter.js';
import { hashOtp } from '../../src/auth/otp.js';
import type { PendingRegistrationDoc, SessionDoc, UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

describe('register routes', () => {
  let pendingRegistrations: PendingRegistrationRepository;
  let users: UserRepository;
  let sessions: SessionRepository;
  let email: FakeEmailSender;
  let webauthn: FakeWebAuthnService;
  let rateLimiter: InMemoryRateLimiter;
  let app: express.Express;

  beforeEach(() => {
    pendingRegistrations = new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>());
    users = new UserRepository(new FakeCollection<UserDoc>());
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    email = new FakeEmailSender();
    webauthn = new FakeWebAuthnService();
    rateLimiter = new InMemoryRateLimiter(() => 0);
    app = express();
    app.use(express.json());
    app.use(cookieParser('test-secret'));
    app.use(
      '/api/auth/register',
      createRegisterRoutes({
        pendingRegistrations, users, email, webauthn, rateLimiter, sessions,
        adminEmail: 'admin@example.com', sessionTtlMs: 1000 * 60 * 60,
        now: () => new Date('2026-07-17T10:00:00.000Z'),
      }),
    );
  });

  it('POST /request emails the admin and sets a pending-reg cookie', async () => {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    expect(res.status).toBe(202);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('admin@example.com');
    expect(email.sent[0].text).toMatch(/\d{6}/);
    expect(email.sent[0].text).toContain('Jane');
    expect(email.sent[0].text).toContain('jane@example.com');
  });

  it('POST /request is throttled after 3 requests from the same IP', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'A', email: 'a@example.com' });
    await agent.post('/api/auth/register/request').send({ name: 'B', email: 'b@example.com' });
    await agent.post('/api/auth/register/request').send({ name: 'C', email: 'c@example.com' });
    const res = await agent.post('/api/auth/register/request').send({ name: 'D', email: 'd@example.com' });
    expect(res.status).toBe(429);
  });

  it('verify-otp rejects wrong codes, locks after 3 attempts, and accepts the right one', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    const otpText = email.sent[0].text;
    const otp = otpText.match(/\d{6}/)?.[0] as string;

    expect((await agent.post('/api/auth/register/verify-otp').send({ otp: '000001' })).status).toBe(400);
    expect((await agent.post('/api/auth/register/verify-otp').send({ otp: '000002' })).status).toBe(400);
    const locked = await agent.post('/api/auth/register/verify-otp').send({ otp: '000003' });
    expect(locked.status).toBe(410);

    // must restart after lockout — the old cookie no longer references a live pending registration
    const retry = await agent.post('/api/auth/register/verify-otp').send({ otp });
    expect(retry.status).toBe(400);
  });

  it('verify-otp succeeds with the correct code', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    const res = await agent.post('/api/auth/register/verify-otp').send({ otp });
    expect(res.status).toBe(200);
  });

  it('passkey/options 400s before verification and succeeds after', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    expect((await agent.post('/api/auth/register/passkey/options')).status).toBe(400);

    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    await agent.post('/api/auth/register/verify-otp').send({ otp });
    const res = await agent.post('/api/auth/register/passkey/options');
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('fake-registration-challenge');
  });

  it('passkey/verify creates the user, admin role for ADMIN_EMAIL, and sets a session cookie', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Admin Person', email: 'admin@example.com' });
    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    await agent.post('/api/auth/register/verify-otp').send({ otp });
    await agent.post('/api/auth/register/passkey/options');

    const res = await agent.post('/api/auth/register/passkey/verify').send({ response: {} });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ name: 'Admin Person', email: 'admin@example.com', role: 'admin' });

    const created = await users.findByEmail('admin@example.com');
    expect(created?.role).toBe('admin');
  });

  it('passkey/verify gives a non-admin-email registrant the member role', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Regular', email: 'regular@example.com' });
    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    await agent.post('/api/auth/register/verify-otp').send({ otp });
    await agent.post('/api/auth/register/passkey/options');
    const res = await agent.post('/api/auth/register/passkey/verify').send({ response: {} });
    expect(res.body.user.role).toBe('member');
  });

  it('passkey/verify 400s when the WebAuthn ceremony fails and creates no user', async () => {
    webauthn.nextRegistrationResult = { verified: false };
    const agent = request.agent(app);
    await agent.post('/api/auth/register/request').send({ name: 'Jane', email: 'jane@example.com' });
    const otp = email.sent[0].text.match(/\d{6}/)?.[0] as string;
    await agent.post('/api/auth/register/verify-otp').send({ otp });
    await agent.post('/api/auth/register/passkey/options');
    const res = await agent.post('/api/auth/register/passkey/verify').send({ response: {} });
    expect(res.status).toBe(400);
    expect(await users.findByEmail('jane@example.com')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/registerRoutes.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/registerRoutes.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/auth/registerRoutes.ts
import { Router } from 'express';
import { z } from 'zod';
import { readPendingRegCookie, setPendingRegCookie, clearPendingRegCookie, setSessionCookie } from './cookies.js';
import { generateOtp, hashOtp, verifyOtp } from './otp.js';
import type { EmailSender } from './emailSender.js';
import type { PendingRegistrationRepository } from './pendingRegistrationRepository.js';
import type { RateLimiter } from './rateLimiter.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserRepository } from './userRepository.js';
import type { WebAuthnService } from './webauthnService.js';

const RequestSchema = z.object({ name: z.string().min(1), email: z.string().email() });
const VerifyOtpSchema = z.object({ otp: z.string().length(6) });
const PasskeyVerifySchema = z.object({ response: z.record(z.string(), z.unknown()) });

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;

export function createRegisterRoutes(deps: {
  pendingRegistrations: PendingRegistrationRepository;
  users: UserRepository;
  sessions: SessionRepository;
  email: EmailSender;
  webauthn: WebAuthnService;
  rateLimiter: RateLimiter;
  adminEmail: string;
  sessionTtlMs: number;
  now?: () => Date;
}): Router {
  const now = deps.now ?? (() => new Date());
  const router = Router();

  router.post('/request', async (req, res) => {
    const parsed = RequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    if (!deps.rateLimiter.consume(`register:${req.ip}`, { limit: 3, windowMs: 60 * 60 * 1000 })) {
      return res.status(429).json({ error: 'too many registration attempts, try again later' });
    }

    const otp = generateOtp();
    const expiresAt = new Date(now().getTime() + OTP_TTL_MS).toISOString();
    const pending = await deps.pendingRegistrations.create({
      name: parsed.data.name,
      email: parsed.data.email,
      otpHash: hashOtp(otp),
      expiresAt,
    });
    setPendingRegCookie(res, pending._id);
    await deps.email.send({
      to: deps.adminEmail,
      subject: 'New registration OTP',
      text: `${parsed.data.name} (${parsed.data.email}) is requesting access. OTP: ${otp}`,
    });
    res.status(202).json({ ok: true });
  });

  router.post('/verify-otp', async (req, res) => {
    const parsed = VerifyOtpSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const pendingId = readPendingRegCookie(req);
    const pending = pendingId ? await deps.pendingRegistrations.findById(pendingId) : null;
    if (!pending || new Date(pending.expiresAt) <= now()) {
      clearPendingRegCookie(res);
      return res.status(400).json({ error: 'no pending registration' });
    }

    if (!verifyOtp(parsed.data.otp, pending.otpHash)) {
      const attempts = await deps.pendingRegistrations.incrementAttempts(pending._id);
      if (attempts >= MAX_OTP_ATTEMPTS) {
        await deps.pendingRegistrations.delete(pending._id);
        clearPendingRegCookie(res);
        return res.status(410).json({ error: 'too many wrong attempts, request a new code' });
      }
      return res.status(400).json({ error: 'wrong code' });
    }

    await deps.pendingRegistrations.markVerified(pending._id);
    res.json({ ok: true });
  });

  router.post('/passkey/options', async (req, res) => {
    const pendingId = readPendingRegCookie(req);
    const pending = pendingId ? await deps.pendingRegistrations.findById(pendingId) : null;
    if (!pending || !pending.verified) return res.status(400).json({ error: 'no verified pending registration' });

    const options = await deps.webauthn.generateRegistrationOptions({ userId: pending._id, email: pending.email });
    await deps.pendingRegistrations.setChallenge(pending._id, options.challenge);
    res.json(options);
  });

  router.post('/passkey/verify', async (req, res) => {
    const parsed = PasskeyVerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const pendingId = readPendingRegCookie(req);
    const pending = pendingId ? await deps.pendingRegistrations.findById(pendingId) : null;
    if (!pending || !pending.verified || !pending.challenge) {
      return res.status(400).json({ error: 'no verified pending registration' });
    }

    const result = await deps.webauthn.verifyRegistration({
      response: parsed.data.response as never,
      expectedChallenge: pending.challenge,
    });
    if (!result.verified || !result.credential) return res.status(400).json({ error: 'passkey verification failed' });

    const role = pending.email.toLowerCase() === deps.adminEmail.toLowerCase() ? 'admin' : 'member';
    const user = await deps.users.create({ name: pending.name, email: pending.email, role, credential: result.credential });
    await deps.pendingRegistrations.delete(pending._id);
    clearPendingRegCookie(res);

    const session = await deps.sessions.create(user._id, deps.sessionTtlMs);
    setSessionCookie(res, session._id, deps.sessionTtlMs);
    res.json({ user: { name: user.name, email: user.email, role: user.role } });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/registerRoutes.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/registerRoutes.ts backend/test/auth/registerRoutes.test.ts
git commit -m "feat: add registration routes (OTP request/verify, passkey enrollment)"
```

---

## Task 9: Login routes

**Files:**
- Create: `backend/src/auth/loginRoutes.ts`
- Test: `backend/test/auth/loginRoutes.test.ts`

**Interfaces:**
- Consumes: `UserRepository`, `SessionRepository` (Task 5), `WebAuthnService` (Task 4), cookie helpers (Task 6), `requireAuth` (Task 7).
- Produces: `function createLoginRoutes(deps: { users: UserRepository; sessions: SessionRepository; webauthn: WebAuthnService; sessionTtlMs: number }): Router` mounted at `/api/auth`, exposing `POST /login/options`, `POST /login/verify`, `POST /logout`, `GET /me`. `/me` requires an active session (mount `requireAuth` on that one route within the router); the other three are public since they're how you establish or clear a session in the first place.
- A per-login-attempt challenge needs somewhere to live between `/login/options` and `/login/verify`. Since login (unlike registration) has no persistent pending record, store it in a short-lived signed cookie: reuse the pending-reg cookie machinery's *shape* but add a dedicated pair in this task: `setLoginChallengeCookie(res, { userId, challenge })` / `readLoginChallengeCookie(req)` / `clearLoginChallengeCookie(res)`, added to `backend/src/auth/cookies.ts` in this task's Step 1 (extends the file from Task 6).

- [ ] **Step 1: Extend cookies.ts with the login-challenge cookie, test first**

Add to `backend/test/auth/cookies.test.ts` (append inside the existing `describe('auth cookies', ...)` block):

```typescript
  it('round-trips the login challenge cookie as JSON', async () => {
    const app = buildApp();
    app.get('/set-login-challenge', (_req, res) => {
      setLoginChallengeCookie(res, { userId: 'user-1', challenge: 'chal-1' });
      res.json({ ok: true });
    });
    app.get('/read-login-challenge', (req, res) => res.json(readLoginChallengeCookie(req) ?? null));
    app.get('/clear-login-challenge', (_req, res) => {
      clearLoginChallengeCookie(res);
      res.json({ ok: true });
    });
    const agent = request.agent(app);
    await agent.get('/set-login-challenge');
    const read = await agent.get('/read-login-challenge');
    expect(read.body).toEqual({ userId: 'user-1', challenge: 'chal-1' });
    await agent.get('/clear-login-challenge');
    expect((await agent.get('/read-login-challenge')).body).toBeNull();
  });
```

Update the test file's import list to include `clearLoginChallengeCookie, readLoginChallengeCookie, setLoginChallengeCookie` from `'../../src/auth/cookies.js'`.

Run: `npm run test -w backend -- test/auth/cookies.test.ts`
Expected: FAIL with "setLoginChallengeCookie is not a function" (or similar — the new export doesn't exist yet)

Add to `backend/src/auth/cookies.ts`:

```typescript
export const LOGIN_CHALLENGE_COOKIE = 'loginChallenge';
const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000; // login ceremony is a single round trip; short-lived

export function setLoginChallengeCookie(res: Response, value: { userId: string; challenge: string }): void {
  res.cookie(LOGIN_CHALLENGE_COOKIE, JSON.stringify(value), {
    httpOnly: true,
    signed: true,
    sameSite: 'strict',
    maxAge: LOGIN_CHALLENGE_TTL_MS,
  });
}

export function readLoginChallengeCookie(req: Request): { userId: string; challenge: string } | undefined {
  const raw = req.signedCookies?.[LOGIN_CHALLENGE_COOKIE];
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.userId === 'string' && typeof parsed?.challenge === 'string') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

export function clearLoginChallengeCookie(res: Response): void {
  res.clearCookie(LOGIN_CHALLENGE_COOKIE);
}
```

Run: `npm run test -w backend -- test/auth/cookies.test.ts`
Expected: PASS (5 tests)

Commit:

```bash
git add backend/src/auth/cookies.ts backend/test/auth/cookies.test.ts
git commit -m "feat: add login-challenge cookie for the login WebAuthn ceremony"
```

- [ ] **Step 2: Write the failing test for the login/logout/me routes**

```typescript
// backend/test/auth/loginRoutes.test.ts
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLoginRoutes } from '../../src/auth/loginRoutes.js';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import { UserRepository } from '../../src/auth/userRepository.js';
import { FakeWebAuthnService } from '../../src/auth/webauthnService.js';
import type { SessionDoc, UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

const credential = { id: 'cred-1', publicKey: 'pk', counter: 0 };

describe('login routes', () => {
  let users: UserRepository;
  let sessions: SessionRepository;
  let webauthn: FakeWebAuthnService;
  let app: express.Express;

  beforeEach(() => {
    users = new UserRepository(new FakeCollection<UserDoc>());
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    webauthn = new FakeWebAuthnService();
    app = express();
    app.use(express.json());
    app.use(cookieParser('test-secret'));
    app.use('/api/auth', createLoginRoutes({ users, sessions, webauthn, sessionTtlMs: 1000 * 60 * 60 }));
  });

  it('login/options 404s for an unknown email', async () => {
    const res = await request(app).post('/api/auth/login/options').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(404);
  });

  it('full login round trip: options -> verify -> me -> logout -> me 401s', async () => {
    const user = await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    const agent = request.agent(app);

    const options = await agent.post('/api/auth/login/options').send({ email: 'jane@example.com' });
    expect(options.status).toBe(200);
    expect(options.body.allowCredentials).toEqual([{ id: 'cred-1' }]);

    const verify = await agent.post('/api/auth/login/verify').send({ email: 'jane@example.com', response: {} });
    expect(verify.status).toBe(200);
    expect(verify.body.user).toEqual({ name: 'Jane', email: 'jane@example.com', role: 'member' });

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ name: 'Jane', email: 'jane@example.com', role: 'member' });

    await agent.post('/api/auth/logout');
    const afterLogout = await agent.get('/api/auth/me');
    expect(afterLogout.status).toBe(401);
    void user;
  });

  it('login/verify 401s when the WebAuthn assertion fails to verify', async () => {
    await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    webauthn.nextAuthenticationResult = { verified: false };
    const agent = request.agent(app);
    await agent.post('/api/auth/login/options').send({ email: 'jane@example.com' });
    const res = await agent.post('/api/auth/login/verify').send({ email: 'jane@example.com', response: {} });
    expect(res.status).toBe(401);
  });

  it('login/verify 400s without a preceding login/options call', async () => {
    await users.create({ name: 'Jane', email: 'jane@example.com', role: 'member', credential });
    const res = await request(app).post('/api/auth/login/verify').send({ email: 'jane@example.com', response: {} });
    expect(res.status).toBe(400);
  });

  it('me 401s when there is no session', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/loginRoutes.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/loginRoutes.js'"

- [ ] **Step 4: Write minimal implementation**

```typescript
// backend/src/auth/loginRoutes.ts
import { Router } from 'express';
import { z } from 'zod';
import {
  clearLoginChallengeCookie,
  clearSessionCookie,
  readLoginChallengeCookie,
  setLoginChallengeCookie,
  setSessionCookie,
} from './cookies.js';
import { requireAuth } from './middleware.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserRepository } from './userRepository.js';
import type { WebAuthnService } from './webauthnService.js';

const EmailSchema = z.object({ email: z.string().email() });
const VerifySchema = z.object({ email: z.string().email(), response: z.record(z.string(), z.unknown()) });

export function createLoginRoutes(deps: {
  users: UserRepository;
  sessions: SessionRepository;
  webauthn: WebAuthnService;
  sessionTtlMs: number;
}): Router {
  const router = Router();

  router.post('/login/options', async (req, res) => {
    const parsed = EmailSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const user = await deps.users.findByEmail(parsed.data.email);
    if (!user) return res.status(404).json({ error: 'no account with that email' });

    const options = await deps.webauthn.generateAuthenticationOptions({ credential: user.credential });
    setLoginChallengeCookie(res, { userId: user._id, challenge: options.challenge });
    res.json(options);
  });

  router.post('/login/verify', async (req, res) => {
    const parsed = VerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const challengeCookie = readLoginChallengeCookie(req);
    const user = await deps.users.findByEmail(parsed.data.email);
    if (!user || !challengeCookie || challengeCookie.userId !== user._id) {
      return res.status(400).json({ error: 'no login in progress for this email' });
    }

    const result = await deps.webauthn.verifyAuthentication({
      response: parsed.data.response as never,
      expectedChallenge: challengeCookie.challenge,
      credential: user.credential,
    });
    clearLoginChallengeCookie(res);
    if (!result.verified) return res.status(401).json({ error: 'passkey verification failed' });

    if (result.newCounter !== undefined) await deps.users.updateCredentialCounter(user._id, result.newCounter);

    const session = await deps.sessions.create(user._id, deps.sessionTtlMs);
    setSessionCookie(res, session._id, deps.sessionTtlMs);
    res.json({ user: { name: user.name, email: user.email, role: user.role } });
  });

  router.post('/logout', async (req, res) => {
    const { readSessionCookie } = await import('./cookies.js');
    const sessionId = readSessionCookie(req);
    if (sessionId) await deps.sessions.delete(sessionId);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(deps.sessions, deps.users, deps.sessionTtlMs), (req, res) => {
    const user = (req as unknown as { user: { name: string; email: string; role: string } }).user;
    res.json({ name: user.name, email: user.email, role: user.role });
  });

  return router;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/loginRoutes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Clean up the dynamic import**

The dynamic `import('./cookies.js')` inside `/logout` in Step 4 works but is an unnecessary oddity — replace it with a top-level import alongside the others already imported at the top of the file (`readSessionCookie` added to the existing `import { ... } from './cookies.js'` line), then re-run the same test command from Step 5 to confirm it still passes before committing.

- [ ] **Step 7: Commit**

```bash
git add backend/src/auth/loginRoutes.ts backend/test/auth/loginRoutes.test.ts
git commit -m "feat: add login, logout, and me routes"
```

---

## Task 10: Admin user-management routes

**Files:**
- Create: `backend/src/auth/adminRoutes.ts`
- Test: `backend/test/auth/adminRoutes.test.ts`

**Interfaces:**
- Consumes: `UserRepository` (Task 5), `requireAuth`/`requireAdmin` (Task 7).
- Produces: `function createAdminRoutes(deps: { users: UserRepository; sessions: SessionRepository; sessionTtlMs: number }): Router` mounted at `/api/admin`, exposing `GET /users` and `PATCH /users/:id/role`, both wrapped in `requireAuth(...)` then `requireAdmin()`.
  - `GET /users` → `200` with `{ users: Array<{ id, name, email, role, createdAt }> }`.
  - `PATCH /users/:id/role { role }` → `400` on invalid role; `404` if the id doesn't exist; `409` (role unchanged) if this change would leave zero admins (i.e. target is currently the only admin and the new role isn't `admin`); otherwise `200` with the updated user summary.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/test/auth/adminRoutes.test.ts
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAdminRoutes } from '../../src/auth/adminRoutes.js';
import { setSessionCookie } from '../../src/auth/cookies.js';
import { SessionRepository } from '../../src/auth/sessionRepository.js';
import { UserRepository } from '../../src/auth/userRepository.js';
import type { SessionDoc, UserDoc } from '../../src/auth/types.js';
import { FakeCollection } from '../support/fakeMongoCollection.js';

const credential = { id: 'cred-1', publicKey: 'pk', counter: 0 };

describe('admin routes', () => {
  let users: UserRepository;
  let sessions: SessionRepository;
  let app: express.Express;

  beforeEach(() => {
    users = new UserRepository(new FakeCollection<UserDoc>());
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    app = express();
    app.use(express.json());
    app.use(cookieParser('test-secret'));
    app.use('/api/admin', createAdminRoutes({ users, sessions, sessionTtlMs: 1000 * 60 * 60 }));
    app.get('/set-cookie/:id', (req, res) => {
      setSessionCookie(res, req.params.id, 1000 * 60 * 60);
      res.json({ ok: true });
    });
  });

  async function agentAs(userId: string) {
    const session = await sessions.create(userId, 1000 * 60 * 60);
    const agent = request.agent(app);
    await agent.get(`/set-cookie/${session._id}`);
    return agent;
  }

  it('GET /users 403s for a member and lists users for an admin', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const member = await users.create({ name: 'Member', email: 'member@example.com', role: 'member', credential });

    const memberAgent = await agentAs(member._id);
    expect((await memberAgent.get('/api/admin/users')).status).toBe(403);

    const adminAgent = await agentAs(admin._id);
    const res = await adminAgent.get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { email: string }) => u.email).sort()).toEqual(['admin@example.com', 'member@example.com']);
  });

  it('PATCH /users/:id/role promotes a member to admin', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const member = await users.create({ name: 'Member', email: 'member@example.com', role: 'member', credential });
    const adminAgent = await agentAs(admin._id);

    const res = await adminAgent.patch(`/api/admin/users/${member._id}/role`).send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('PATCH /users/:id/role refuses to demote the last remaining admin', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin._id);

    const res = await adminAgent.patch(`/api/admin/users/${admin._id}/role`).send({ role: 'member' });
    expect(res.status).toBe(409);
    expect((await users.findById(admin._id))?.role).toBe('admin');
  });

  it('PATCH /users/:id/role allows demoting an admin when another admin remains', async () => {
    const admin1 = await users.create({ name: 'Admin1', email: 'admin1@example.com', role: 'admin', credential });
    const admin2 = await users.create({ name: 'Admin2', email: 'admin2@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin1._id);

    const res = await adminAgent.patch(`/api/admin/users/${admin2._id}/role`).send({ role: 'member' });
    expect(res.status).toBe(200);
  });

  it('PATCH /users/:id/role 404s for an unknown user and 400s for an invalid role', async () => {
    const admin = await users.create({ name: 'Admin', email: 'admin@example.com', role: 'admin', credential });
    const adminAgent = await agentAs(admin._id);
    expect((await adminAgent.patch('/api/admin/users/nope/role').send({ role: 'member' })).status).toBe(404);
    expect((await adminAgent.patch(`/api/admin/users/${admin._id}/role`).send({ role: 'superadmin' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- test/auth/adminRoutes.test.ts`
Expected: FAIL with "Cannot find module '../../src/auth/adminRoutes.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// backend/src/auth/adminRoutes.ts
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from './middleware.js';
import type { SessionRepository } from './sessionRepository.js';
import type { UserRepository } from './userRepository.js';

const RoleSchema = z.object({ role: z.enum(['admin', 'member']) });

export function createAdminRoutes(deps: { users: UserRepository; sessions: SessionRepository; sessionTtlMs: number }): Router {
  const router = Router();
  router.use(requireAuth(deps.sessions, deps.users, deps.sessionTtlMs), requireAdmin());

  router.get('/users', async (_req, res) => {
    const all = await deps.users.findAll();
    res.json({
      users: all.map((u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })),
    });
  });

  router.patch('/users/:id/role', async (req, res) => {
    const parsed = RoleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const target = await deps.users.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'user not found' });

    if (target.role === 'admin' && parsed.data.role !== 'admin') {
      const adminCount = await deps.users.countByRole('admin');
      if (adminCount <= 1) return res.status(409).json({ error: 'cannot demote the last remaining admin' });
    }

    await deps.users.updateRole(target._id, parsed.data.role);
    res.json({ id: target._id, name: target.name, email: target.email, role: parsed.data.role, createdAt: target.createdAt });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- test/auth/adminRoutes.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/adminRoutes.ts backend/test/auth/adminRoutes.test.ts
git commit -m "feat: add admin user-list and role-change routes with last-admin safety rail"
```

---

## Task 11: Wire auth into `api/app.ts`

**Files:**
- Modify: `backend/src/api/app.ts`
- Modify: `backend/test/app.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–10.
- `createApp`'s `deps` parameter grows: add `pendingRegistrations: PendingRegistrationRepository`, `users: UserRepository`, `sessions: SessionRepository`, `email: EmailSender`, `webauthn: WebAuthnService`, `rateLimiter: RateLimiter`, `adminEmail: string`, `sessionTtlMs: number`, `cookieSecret: string`.
- `app.use(cookieParser(deps.cookieSecret))` before any route.
- Mount `createRegisterRoutes(...)` at `/api/auth/register`, `createLoginRoutes(...)` at `/api/auth`, `createAdminRoutes(...)` at `/api/admin`.
- Every existing route except `/api/health` and everything under `/api/auth` gets `requireAuth(deps.sessions, deps.users, deps.sessionTtlMs)`. `/api/scrape` and `/api/scrape/cancel` additionally get `requireAdmin()`.

- [ ] **Step 1: Update `app.test.ts`'s `beforeEach` to build the new deps and assert gating, before touching `app.ts`**

Add these imports to the top of `backend/test/app.test.ts`:

```typescript
import { PendingRegistrationRepository } from '../src/auth/pendingRegistrationRepository.js';
import { UserRepository } from '../src/auth/userRepository.js';
import { SessionRepository } from '../src/auth/sessionRepository.js';
import { FakeEmailSender } from '../src/auth/emailSender.js';
import { FakeWebAuthnService } from '../src/auth/webauthnService.js';
import { InMemoryRateLimiter } from '../src/auth/rateLimiter.js';
import { setSessionCookie } from '../src/auth/cookies.js';
import type { PendingRegistrationDoc, SessionDoc, UserDoc } from '../src/auth/types.js';
```

Replace the existing `beforeEach` block with:

```typescript
  let sessions: SessionRepository;
  let users: UserRepository;

  beforeEach(() => {
    tendersCollection = new FakeCollection<TenderDoc>();
    repo = new TenderRepository(tendersCollection, new FakeCollection<SourceMetaDoc>());
    manager = new ScrapeManager([], repo);
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    users = new UserRepository(new FakeCollection<UserDoc>());
    app = createApp({
      repo, tendersCollection, manager,
      pendingRegistrations: new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>()),
      users, sessions,
      email: new FakeEmailSender(),
      webauthn: new FakeWebAuthnService(),
      rateLimiter: new InMemoryRateLimiter(),
      adminEmail: 'admin@example.com',
      sessionTtlMs: 1000 * 60 * 60,
      cookieSecret: 'test-secret',
    });
  });

  async function loginAsAgent(role: 'admin' | 'member') {
    const user = await users.create({
      name: role, email: `${role}@example.com`, role,
      credential: { id: `${role}-cred`, publicKey: 'pk', counter: 0 },
    });
    const session = await sessions.create(user._id, 1000 * 60 * 60);
    const agent = request.agent(app);
    await agent.get('/api/health'); // establishes cookie jar; harmless no-auth route
    // supertest agents need a route to *set* the cookie via a Set-Cookie header — use a
    // throwaway request against the login-verify-style cookie setter isn't available here,
    // so set the cookie directly using supertest's `.set('Cookie', ...)`. cookie-parser signs
    // cookies with an `s:` prefix + HMAC; reproduce that using the same signing the app uses.
    return { agent, session };
  }
```

This `loginAsAgent` sketch above has a real problem worth calling out explicitly: hand-signing a cookie to match `cookie-parser`'s internal format is fragile and duplicates library internals. **Do not implement it that way.** Instead, add one tiny test-only route to `app.test.ts`'s local supertest usage — call the *real* login flow through the app itself, using the `FakeWebAuthnService`'s default `verified: true` result, exactly like `registerRoutes.test.ts` and `loginRoutes.test.ts` already do. Replace the `loginAsAgent` sketch with:

```typescript
  async function loginAsAgent(role: 'admin' | 'member') {
    const user = await users.create({
      name: role, email: `${role}@example.com`, role,
      credential: { id: `${role}-cred`, publicKey: 'pk', counter: 0 },
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login/options').send({ email: user.email });
    await agent.post('/api/auth/login/verify').send({ email: user.email, response: {} });
    return agent;
  }
```

Now add gating assertions — append inside the existing `describe('API', ...)` block:

```typescript
  it('rejects unauthenticated requests to a protected route', async () => {
    const res = await request(app).get('/api/tenders');
    expect(res.status).toBe(401);
  });

  it('allows an authenticated member to read tenders but not trigger a rescrape', async () => {
    const agent = await loginAsAgent('member');
    expect((await agent.get('/api/tenders')).status).toBe(200);
    expect((await agent.post('/api/scrape').send({})).status).toBe(403);
  });

  it('allows an authenticated admin to trigger a rescrape', async () => {
    const agent = await loginAsAgent('admin');
    const res = await agent.post('/api/scrape').send({});
    expect(res.status).toBe(202);
  });

  it('GET /api/health stays open with no auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
```

Every other existing test in `app.test.ts` (e.g. `GET /api/tenders returns paginated, filterable results`) currently calls `request(app)` directly without logging in first — those must be updated to go through `loginAsAgent('member')` (or `'admin'` for the ones hitting `/api/scrape*`) since the routes are now gated. Go through each existing `it(...)` in the file and replace `const res = await request(app)...` with `const agent = await loginAsAgent('member'); const res = await agent...` (or reuse one shared `agent` per test where multiple calls are made), keeping assertions unchanged. Do this for every test currently calling `/api/tenders`, `/api/tenders/facets`, `/api/tenders/:refNo`, `/api/dashboard`, `/api/sources`, `/api/scrape/status` — all now require at least a `'member'` session; the ones already calling `/api/scrape` or `/api/scrape/cancel` need `'admin'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w backend -- test/app.test.ts`
Expected: FAIL — `createApp` doesn't accept the new deps yet (TypeScript error) and/or every route returns 401 because `app.ts` doesn't gate or recognize sessions yet.

- [ ] **Step 3: Update `app.ts`**

```typescript
// backend/src/api/app.ts — add these imports near the top, alongside the existing ones
import cookieParser from 'cookie-parser';
import { createAdminRoutes } from '../auth/adminRoutes.js';
import { createLoginRoutes } from '../auth/loginRoutes.js';
import { createRegisterRoutes } from '../auth/registerRoutes.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import type { PendingRegistrationRepository } from '../auth/pendingRegistrationRepository.js';
import type { UserRepository } from '../auth/userRepository.js';
import type { SessionRepository } from '../auth/sessionRepository.js';
import type { EmailSender } from '../auth/emailSender.js';
import type { WebAuthnService } from '../auth/webauthnService.js';
import type { RateLimiter } from '../auth/rateLimiter.js';
```

Change the `createApp` signature and body:

```typescript
export function createApp(deps: {
  repo: TenderRepository;
  tendersCollection: QueryableCollection<TenderDoc>;
  manager: ScrapeManager;
  pendingRegistrations: PendingRegistrationRepository;
  users: UserRepository;
  sessions: SessionRepository;
  email: EmailSender;
  webauthn: WebAuthnService;
  rateLimiter: RateLimiter;
  adminEmail: string;
  sessionTtlMs: number;
  cookieSecret: string;
}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(deps.cookieSecret));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.use('/api/auth/register', createRegisterRoutes({
    pendingRegistrations: deps.pendingRegistrations,
    users: deps.users,
    sessions: deps.sessions,
    email: deps.email,
    webauthn: deps.webauthn,
    rateLimiter: deps.rateLimiter,
    adminEmail: deps.adminEmail,
    sessionTtlMs: deps.sessionTtlMs,
  }));
  app.use('/api/auth', createLoginRoutes({
    users: deps.users, sessions: deps.sessions, webauthn: deps.webauthn, sessionTtlMs: deps.sessionTtlMs,
  }));
  app.use('/api/admin', createAdminRoutes({ users: deps.users, sessions: deps.sessions, sessionTtlMs: deps.sessionTtlMs }));

  const auth = requireAuth(deps.sessions, deps.users, deps.sessionTtlMs);

  app.get('/api/sources', auth, async (_req, res) => {
    res.json(await deps.manager.listSources());
  });

  app.get('/api/tenders/facets', auth, async (_req, res) => {
    res.json(await buildFacets(deps.tendersCollection));
  });

  app.get('/api/dashboard', auth, async (_req, res) => {
    res.json(buildDashboardStats(await deps.repo.findAwarded()));
  });

  app.get('/api/tenders/:refNo', auth, async (req, res) => {
    const key = computeDedupKey(req.params.refNo, req.params.refNo);
    const tender = await deps.repo.findByDedupKey(key);
    if (!tender) return res.status(404).json({ error: 'tender not found' });
    res.json({ tender });
  });

  app.get('/api/tenders', auth, async (req, res) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.json(await queryTenders(deps.tendersCollection, parsed.data));
  });

  app.post('/api/scrape', auth, requireAdmin(), async (req, res) => {
    const parsed = ScrapeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    if (parsed.data.scope === 'results') {
      if (!parsed.data.source) return res.status(400).json({ error: 'source is required for scope=results' });
      const started = await deps.manager.refreshResults(parsed.data.source);
      if (!started) return res.status(409).json({ error: 'cannot refresh results for this source' });
      return res.status(202).json({ started: true });
    }
    const scope = parsed.data.scope === 'full' ? 'all' : 'open';
    const started = deps.manager.start(scope, { sourceName: parsed.data.source });
    if (!started) return res.status(409).json({ error: 'scrape already running' });
    res.status(202).json({ started: true });
  });

  app.post('/api/scrape/cancel', auth, requireAdmin(), (_req, res) => {
    if (!deps.manager.cancel()) return res.status(409).json({ error: 'nothing running' });
    res.json({ cancelled: true });
  });

  app.get('/api/scrape/status', auth, (_req, res) => {
    res.json(deps.manager.status());
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w backend -- test/app.test.ts`
Expected: PASS (all existing tests plus the new gating tests)

- [ ] **Step 5: Run the full backend suite to catch any other call sites**

Run: `npm run test -w backend`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/app.ts backend/test/app.test.ts
git commit -m "feat: gate the API behind requireAuth/requireAdmin and mount auth routes"
```

---

## Task 12: Wire real dependencies into `index.ts`, env vars, and Mongo indexes

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml` (if it references backend env vars — check first; add the same keys there too)
- Create: `backend/.env.example` (if one doesn't already exist — check first; this repo currently has none, so create it)

**Interfaces:**
- Consumes: every real implementation from Tasks 1–10, plus `PendingRegistrationDoc`, `UserDoc`, `SessionDoc` (Task 5).
- No new interfaces produced — this is pure wiring, not unit-tested (matches the existing `index.ts`, which is excluded from coverage in `backend/vitest.config.ts`'s `exclude: ['src/index.ts']`).

- [ ] **Step 1: Add the new Mongo collections, TTL indexes, and real service instances to `index.ts`**

In `backend/src/index.ts`, add these imports:

```typescript
import cookieParser from 'cookie-parser'; // not used directly here, but confirms it's installed; actual use is in app.ts
import { PendingRegistrationRepository } from './auth/pendingRegistrationRepository.js';
import { UserRepository } from './auth/userRepository.js';
import { SessionRepository } from './auth/sessionRepository.js';
import { MailerSendEmailSender } from './auth/emailSender.js';
import { SimpleWebAuthnService } from './auth/webauthnService.js';
import { InMemoryRateLimiter } from './auth/rateLimiter.js';
import type { PendingRegistrationDoc, SessionDoc, UserDoc } from './auth/types.js';
```

(Drop the unused `cookieParser` import above if `tsc` flags it as unused — `app.ts` already imports it directly; this file doesn't need to.)

Add env var reads near `PORT`/`MONGO_URI`:

```typescript
const MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY ?? '';
const MAILERSEND_FROM_EMAIL = process.env.MAILERSEND_FROM_EMAIL ?? 'noreply@example.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? '';
const SESSION_SECRET = process.env.SESSION_SECRET ?? '';
const RP_ID = process.env.RP_ID ?? 'localhost';
const RP_NAME = process.env.RP_NAME ?? 'Malaysia Tender Aggregator';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

if (!ADMIN_EMAIL || !SESSION_SECRET || !MAILERSEND_API_KEY) {
  throw new Error('ADMIN_EMAIL, SESSION_SECRET, and MAILERSEND_API_KEY must be set');
}
```

Inside `main()`, after the existing collection setup (`tendersCollection`, `sourceMetaCollection`, `schedulerStateCollection`), add:

```typescript
  const pendingRegistrationsCollection = db.collection<PendingRegistrationDoc>('pendingRegistrations');
  const usersCollection = db.collection<UserDoc>('users');
  const sessionsCollection = db.collection<SessionDoc>('sessions');

  await Promise.all([
    pendingRegistrationsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    usersCollection.createIndex({ email: 1 }, { unique: true }),
    sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);

  const pendingRegistrations = new PendingRegistrationRepository(pendingRegistrationsCollection);
  const users = new UserRepository(usersCollection);
  const sessions = new SessionRepository(sessionsCollection);
  const email = new MailerSendEmailSender(MAILERSEND_API_KEY, MAILERSEND_FROM_EMAIL);
  const webauthn = new SimpleWebAuthnService(RP_ID, RP_NAME, ORIGIN);
  const rateLimiter = new InMemoryRateLimiter();
```

Update the final `createApp({...})` call:

```typescript
  createApp({
    repo, tendersCollection, manager,
    pendingRegistrations, users, sessions, email, webauthn, rateLimiter,
    adminEmail: ADMIN_EMAIL,
    sessionTtlMs: SESSION_TTL_MS,
    cookieSecret: SESSION_SECRET,
  }).listen(PORT, () => {
    console.log(`backend listening on :${PORT}`);
  });
```

`db.collection<T>(...)` (the real `mongodb` driver's `Collection<T>`) already structurally satisfies `QueryableCollection<T>` including the `deleteOne` method added in Task 5 — the real driver has always had `deleteOne`, so no driver-side change is needed there, only the interface catch-up.

- [ ] **Step 2: Check `docker-compose.prod.yml` for its current backend env var list**

Read the file's `backend` service `environment:` block. Add the same six keys (`MAILERSEND_API_KEY`, `MAILERSEND_FROM_EMAIL`, `ADMIN_EMAIL`, `SESSION_SECRET`, `RP_ID`, `RP_NAME`, `ORIGIN`) as either hardcoded dev-safe values (for `docker-compose.yml`, the local dev stack) or `${VAR}`-style passthroughs sourced from the host environment (for `docker-compose.prod.yml`, matching whatever pattern that file already uses for existing secrets, if any — if it has none yet, use the same `${VAR:?err}` pattern Docker Compose supports for required vars, or plain `${VAR}` if the file's existing style is more permissive; follow the file's existing convention rather than introducing a new one).

- [ ] **Step 3: Add `backend/.env.example`**

```
PORT=3001
MONGO_URI=mongodb://localhost:27017/tms
MAILERSEND_API_KEY=
MAILERSEND_FROM_EMAIL=noreply@example.com
ADMIN_EMAIL=
SESSION_SECRET=
RP_ID=localhost
RP_NAME=Malaysia Tender Aggregator
ORIGIN=http://localhost:5173
```

- [ ] **Step 4: Update `docker-compose.yml`'s `backend.environment` block**

Add the six new keys with local-dev-safe placeholder values (a real `MAILERSEND_API_KEY` still has to be supplied by the developer locally — leave it as an empty/placeholder value with a comment, not a fabricated fake key):

```yaml
      - MAILERSEND_API_KEY=${MAILERSEND_API_KEY} # set in your shell or a local .env before `docker compose up`
      - MAILERSEND_FROM_EMAIL=noreply@example.com
      - ADMIN_EMAIL=${ADMIN_EMAIL}
      - SESSION_SECRET=${SESSION_SECRET}
      - RP_ID=localhost
      - RP_NAME=Malaysia Tender Aggregator
      - ORIGIN=http://localhost:8080
```

- [ ] **Step 5: Typecheck and run the full backend suite**

Run: `npm run test -w backend`
Expected: PASS (index.ts itself has no tests — it's excluded from coverage — but this confirms nothing else broke and that it still compiles under `tsx`)

Run: `cd backend && npx tsc --noEmit`
Expected: no type errors

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.ts docker-compose.yml docker-compose.prod.yml backend/.env.example
git commit -m "feat: wire real auth dependencies, env vars, and TTL/unique indexes into index.ts"
```

---

## Task 13: Frontend API client for auth

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/test/mocks.ts`
- Test: `frontend/src/test/client.test.ts` (append)

**Interfaces:**
- Produces (added to `api/types.ts`):
  ```typescript
  export type Role = 'admin' | 'member';
  export interface CurrentUser { name: string; email: string; role: Role }
  export interface AdminUser { id: string; name: string; email: string; role: Role; createdAt: string }
  ```
- Produces (added to `api/client.ts`):
  ```typescript
  export function registerRequest(params: { name: string; email: string }): Promise<void>;
  export function verifyRegistrationOtp(otp: string): Promise<void>;
  export function getPasskeyRegistrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON>;
  export function verifyPasskeyRegistration(response: RegistrationResponseJSON): Promise<{ user: CurrentUser }>;
  export function getLoginOptions(email: string): Promise<PublicKeyCredentialRequestOptionsJSON>;
  export function verifyLogin(email: string, response: AuthenticationResponseJSON): Promise<{ user: CurrentUser }>;
  export function logout(): Promise<void>;
  export function fetchMe(): Promise<CurrentUser>;
  export function fetchAdminUsers(): Promise<AdminUser[]>;
  export function updateUserRole(id: string, role: Role): Promise<AdminUser>;
  ```
  (`PublicKeyCredentialCreationOptionsJSON` etc. come from `@simplewebauthn/browser`, added as a frontend dependency in this task.)

- [ ] **Step 1: Add the frontend WebAuthn dependency**

```bash
npm install @simplewebauthn/browser@^13.3.0 -w frontend
```

- [ ] **Step 2: Extend `api/types.ts`**

Append to `frontend/src/api/types.ts`:

```typescript
export type Role = 'admin' | 'member';
export interface CurrentUser { name: string; email: string; role: Role }
export interface AdminUser { id: string; name: string; email: string; role: Role; createdAt: string }
```

- [ ] **Step 3: Write the failing test**

Append to `frontend/src/test/client.test.ts` (add to the existing top-level `import` line the new client functions, and add `HttpResponse`/`http` are already imported):

```typescript
  it('fetchMe returns the current user, and throws 401 as an error', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Jane', email: 'jane@example.com', role: 'member' })));
    expect(await fetchMe()).toEqual({ name: 'Jane', email: 'jane@example.com', role: 'member' });
    server.use(http.get('/api/auth/me', () => HttpResponse.json({ error: 'not authenticated' }, { status: 401 })));
    await expect(fetchMe()).rejects.toThrow();
  });

  it('registerRequest posts name/email and resolves on 202', async () => {
    let seenBody: unknown;
    server.use(http.post('/api/auth/register/request', async ({ request }) => {
      seenBody = await request.json();
      return HttpResponse.json({ ok: true }, { status: 202 });
    }));
    await registerRequest({ name: 'Jane', email: 'jane@example.com' });
    expect(seenBody).toEqual({ name: 'Jane', email: 'jane@example.com' });
  });

  it('registerRequest throws on 429', async () => {
    server.use(http.post('/api/auth/register/request', () => HttpResponse.json({ error: 'throttled' }, { status: 429 })));
    await expect(registerRequest({ name: 'Jane', email: 'jane@example.com' })).rejects.toThrow();
  });

  it('verifyRegistrationOtp posts the otp and resolves on 200, throws otherwise', async () => {
    server.use(http.post('/api/auth/register/verify-otp', () => HttpResponse.json({ ok: true })));
    await expect(verifyRegistrationOtp('123456')).resolves.toBeUndefined();
    server.use(http.post('/api/auth/register/verify-otp', () => HttpResponse.json({ error: 'wrong code' }, { status: 400 })));
    await expect(verifyRegistrationOtp('000000')).rejects.toThrow();
  });

  it('logout posts to /api/auth/logout', async () => {
    let called = false;
    server.use(http.post('/api/auth/logout', () => {
      called = true;
      return HttpResponse.json({ ok: true });
    }));
    await logout();
    expect(called).toBe(true);
  });

  it('fetchAdminUsers and updateUserRole hit the admin endpoints', async () => {
    server.use(http.get('/api/admin/users', () => HttpResponse.json({
      users: [{ id: '1', name: 'A', email: 'a@example.com', role: 'admin', createdAt: '2026-07-17T00:00:00.000Z' }],
    })));
    expect(await fetchAdminUsers()).toEqual([{ id: '1', name: 'A', email: 'a@example.com', role: 'admin', createdAt: '2026-07-17T00:00:00.000Z' }]);

    server.use(http.patch('/api/admin/users/1/role', () => HttpResponse.json({ id: '1', name: 'A', email: 'a@example.com', role: 'member', createdAt: '2026-07-17T00:00:00.000Z' })));
    expect((await updateUserRole('1', 'member')).role).toBe('member');
  });
```

Add the new imports to the top of `frontend/src/test/client.test.ts`:

```typescript
import { fetchAdminUsers, fetchMe, logout, registerRequest, updateUserRole, verifyRegistrationOtp } from '../api/client';
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run test -w frontend -- src/test/client.test.ts`
Expected: FAIL — the new exports don't exist in `../api/client`

- [ ] **Step 5: Write minimal implementation**

Append to `frontend/src/api/client.ts`:

```typescript
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { AdminUser, CurrentUser, Role } from './types';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export async function registerRequest(params: { name: string; email: string }): Promise<void> {
  await postJson('/api/auth/register/request', params);
}

export async function verifyRegistrationOtp(otp: string): Promise<void> {
  await postJson('/api/auth/register/verify-otp', { otp });
}

export function getPasskeyRegistrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return postJson('/api/auth/register/passkey/options', {});
}

export function verifyPasskeyRegistration(response: RegistrationResponseJSON): Promise<{ user: CurrentUser }> {
  return postJson('/api/auth/register/passkey/verify', { response });
}

export function getLoginOptions(email: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return postJson('/api/auth/login/options', { email });
}

export function verifyLogin(email: string, response: AuthenticationResponseJSON): Promise<{ user: CurrentUser }> {
  return postJson('/api/auth/login/verify', { email, response });
}

export async function logout(): Promise<void> {
  await postJson('/api/auth/logout', {});
}

export function fetchMe(): Promise<CurrentUser> {
  return getJson('/api/auth/me');
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const body = await getJson<{ users: AdminUser[] }>('/api/admin/users');
  return body.users;
}

export async function updateUserRole(id: string, role: Role): Promise<AdminUser> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error(`update role failed: ${res.status}`);
  return res.json() as Promise<AdminUser>;
}
```

- [ ] **Step 6: Add default MSW handlers for the new endpoints**

Append to the `handlers` array in `frontend/src/test/mocks.ts` (so other tests that render auth-aware components don't need to redeclare these every time):

```typescript
  http.get('/api/auth/me', () => HttpResponse.json({ name: 'Test User', email: 'test@example.com', role: 'member' })),
  http.post('/api/auth/logout', () => HttpResponse.json({ ok: true })),
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run test -w frontend -- src/test/client.test.ts`
Expected: PASS (all prior tests + 6 new ones)

- [ ] **Step 8: Run the full frontend suite**

Run: `npm run test -w frontend`
Expected: PASS (the new default `/api/auth/me` handler in `mocks.ts` must not break any existing test — none of them currently assert on that route)

- [ ] **Step 9: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/test/client.test.ts frontend/src/test/mocks.ts
git commit -m "feat: add frontend API client functions for auth, login, registration, and admin routes"
```

---

## Task 14: Auth context (current-user state)

**Files:**
- Create: `frontend/src/auth/AuthContext.tsx`
- Test: `frontend/src/auth/AuthContext.test.tsx`

**Interfaces:**
- Consumes: `fetchMe`, `logout` from `../api/client` (Task 13).
- Produces:
  ```typescript
  export interface AuthState { user: CurrentUser | null; loading: boolean; refresh: () => Promise<void>; signOut: () => Promise<void> }
  export function AuthProvider({ children }: { children: ReactNode }): JSX.Element;
  export function useAuth(): AuthState;
  ```
  On mount, `AuthProvider` calls `fetchMe()`; on success sets `user`; on failure (401) sets `user: null`. `loading` is `true` until that first call resolves either way. `refresh()` re-runs the same fetch (used right after a successful login/registration to populate `user` without a full page reload). `signOut()` calls `logout()` then sets `user: null`.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/auth/AuthContext.test.tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w frontend -- src/auth/AuthContext.test.tsx`
Expected: FAIL with "Cannot find module './AuthContext'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// frontend/src/auth/AuthContext.tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchMe, logout } from '../api/client';
import type { CurrentUser } from '../api/types';

export interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser(await fetchMe());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, refresh, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w frontend -- src/auth/AuthContext.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/auth/AuthContext.tsx frontend/src/auth/AuthContext.test.tsx
git commit -m "feat: add AuthContext for current-user state"
```

---

## Task 15: Login page

**Files:**
- Create: `frontend/src/pages/LoginPage.tsx`
- Test: `frontend/src/test/LoginPage.test.tsx`

**Interfaces:**
- Consumes: `getLoginOptions`, `verifyLogin` (Task 13), `useAuth` (Task 14), `startAuthentication` from `@simplewebauthn/browser`.
- Produces: `export default function LoginPage(): JSX.Element` — an email input, a "Sign in with passkey" button. On submit: calls `getLoginOptions(email)`, passes the result to `startAuthentication({ optionsJSON: options })`, sends the result to `verifyLogin(email, assertion)`, then calls `refresh()` from `useAuth()` and navigates to `/`. Shows an error message on any failure (unknown email, cancelled ceremony, failed verification) without leaking which specific step failed.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/test/LoginPage.test.tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w frontend -- src/test/LoginPage.test.tsx`
Expected: FAIL with "Cannot find module '../pages/LoginPage'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// frontend/src/pages/LoginPage.tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w frontend -- src/test/LoginPage.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/LoginPage.tsx frontend/src/test/LoginPage.test.tsx
git commit -m "feat: add LoginPage (email + passkey sign-in)"
```

---

## Task 16: Register page (multi-step)

**Files:**
- Create: `frontend/src/pages/RegisterPage.tsx`
- Test: `frontend/src/test/RegisterPage.test.tsx`

**Interfaces:**
- Consumes: `registerRequest`, `verifyRegistrationOtp`, `getPasskeyRegistrationOptions`, `verifyPasskeyRegistration` (Task 13), `useAuth` (Task 14), `startRegistration` from `@simplewebauthn/browser`.
- Produces: `export default function RegisterPage(): JSX.Element` — three-step local component state machine: `'details' | 'otp' | 'passkey'`.
  - Step `'details'`: name + email form → `registerRequest({ name, email })` → advance to `'otp'`.
  - Step `'otp'`: 6-digit code input → `verifyRegistrationOtp(otp)` → on `410` show a "too many attempts, start over" message and reset to `'details'`; on other failure show inline error and stay on `'otp'`; on success advance to `'passkey'`.
  - Step `'passkey'`: a button "Create passkey" → `getPasskeyRegistrationOptions()` → `startRegistration({ optionsJSON: options })` → `verifyPasskeyRegistration(response)` → `refresh()` from `useAuth()` → navigate to `/`.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/test/RegisterPage.test.tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w frontend -- src/test/RegisterPage.test.tsx`
Expected: FAIL with "Cannot find module '../pages/RegisterPage'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// frontend/src/pages/RegisterPage.tsx
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
    } catch {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w frontend -- src/test/RegisterPage.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/RegisterPage.tsx frontend/src/test/RegisterPage.test.tsx
git commit -m "feat: add RegisterPage (details -> OTP -> passkey enrollment)"
```

---

## Task 17: Admin users page

**Files:**
- Create: `frontend/src/pages/AdminUsersPage.tsx`
- Test: `frontend/src/test/AdminUsersPage.test.tsx`

**Interfaces:**
- Consumes: `fetchAdminUsers`, `updateUserRole` (Task 13), `@tanstack/react-query`.
- Produces: `export default function AdminUsersPage(): JSX.Element` — a table of users (name, email, role, created date) with a role `<select>` per row that calls `updateUserRole` on change and invalidates the `['admin-users']` query on settle.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/test/AdminUsersPage.test.tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w frontend -- src/test/AdminUsersPage.test.tsx`
Expected: FAIL with "Cannot find module '../pages/AdminUsersPage'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// frontend/src/pages/AdminUsersPage.tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAdminUsers, updateUserRole } from '../api/client';
import type { Role } from '../api/types';

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { data: users } = useQuery({ queryKey: ['admin-users'], queryFn: fetchAdminUsers });
  const roleMutation = useMutation({
    mutationFn: (params: { id: string; role: Role }) => updateUserRole(params.id, params.role),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-semibold text-lg">Manage users</h1>
      <div className="border border-[#e0e0e0] rounded-lg divide-y">
        {(users ?? []).map((u) => (
          <div key={u.id} className="p-4 flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">{u.name}</div>
              <div className="text-xs text-gray-500">{u.email} · joined {u.createdAt.slice(0, 10)}</div>
            </div>
            <label className="text-sm">
              <span className="sr-only">Role for {u.email}</span>
              <select
                aria-label={`Role for ${u.email}`}
                value={u.role}
                onChange={(e) => roleMutation.mutate({ id: u.id, role: e.target.value as Role })}
                className="border border-[#e0e0e0] rounded-md px-2 py-1"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w frontend -- src/test/AdminUsersPage.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/AdminUsersPage.tsx frontend/src/test/AdminUsersPage.test.tsx
git commit -m "feat: add AdminUsersPage for role management"
```

---

## Task 18: Wire routing, guards, and role-based UI into `App.tsx` and `SettingsPage.tsx`

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/pages/SettingsPage.tsx`
- Modify: `frontend/src/main.tsx`
- Test: `frontend/src/test/App.test.tsx` (append)
- Test: `frontend/src/test/SettingsPage.test.tsx` (append)

**Interfaces:**
- Consumes: `AuthProvider`/`useAuth` (Task 14), `LoginPage` (Task 15), `RegisterPage` (Task 16), `AdminUsersPage` (Task 17).
- `App.tsx` gets a `RequireAuth` wrapper component (defined inline in this file, not exported elsewhere — it's App-routing-specific) that renders `<Navigate to="/login" />` when `!loading && !user`, renders nothing (or a simple loading state) while `loading`, and renders `children` once authenticated. `/login` and `/register` routes sit outside this wrapper; every other existing route is wrapped. A new `/admin/users` route, wrapped in both `RequireAuth` and a role check (`user?.role === 'admin'`, else `<Navigate to="/" />`), renders `AdminUsersPage`.
- `SettingsPage.tsx`'s rescrape/cancel/refresh buttons become conditional on `useAuth().user?.role === 'admin'`.

- [ ] **Step 1: Read the current `main.tsx` to see where to add `AuthProvider`**

Check `frontend/src/main.tsx` — it currently renders `<App />` (or similar) into the DOM. `AuthProvider` needs to wrap `App` so `useAuth()` works inside it, but `App.tsx` already owns `QueryClientProvider` and `BrowserRouter` internally. Add `AuthProvider` as the outermost wrapper in `App.tsx` itself (inside the existing `export default function App()`), not in `main.tsx` — this keeps `main.tsx` a plain "mount the app" file and matches how `QueryClientProvider`/`BrowserRouter` are already owned by `App.tsx` rather than `main.tsx`. No change to `main.tsx` is actually needed; remove it from the Files list above if inspection confirms this.

- [ ] **Step 2: Write the failing tests**

`frontend/src/test/App.test.tsx` currently calls `render(<App />)` directly with no MSW override — it will pick up the default `/api/auth/me` handler added to `frontend/src/test/mocks.ts` in Task 13, which resolves to a logged-in `member` user. That means all of `App.test.tsx`'s *existing* tests keep passing unchanged (the app renders authenticated by default), and only new tests need explicit `server.use(...)` overrides. Append these inside the existing `describe('App', ...)` block, and add `import { http, HttpResponse } from 'msw';` and `import { server } from './mocks';` and `import { waitFor } from '@testing-library/react';` (extend the existing `@testing-library/react` import) to the top of the file:

```typescript
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
    const link = await screen.findByRole('link', { name: 'Manage users' });
    await userEvent.click(link);
    expect(await screen.findByText('Manage users')).toBeInTheDocument(); // page heading, once AdminUsersPage's own /api/admin/users call resolves via its own test-local handler if needed — this page renders even with an empty/default list
  });
```

`frontend/src/test/SettingsPage.test.tsx`'s existing 10 tests all assume the rescrape/fetch/cancel buttons are visible — once `SettingsPage` is gated by role, those tests need the mocked current user to be an `admin` by default. Update the file's `renderSettings()` helper (defined at the top) to wrap in `AuthProvider` and default the mocked session to admin, so none of the 10 existing tests need to change:

```typescript
// frontend/src/test/SettingsPage.test.tsx — replace the existing renderSettings() and add imports
import { AuthProvider } from '../auth/AuthContext';
// (keep all existing imports; add the one above)

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Admin', email: 'admin@example.com', role: 'admin' })));
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}
```

Then append one new test to the existing `describe('SettingsPage', ...)` block for the member case, which needs its own local override *after* calling a variant of the helper — add a second helper alongside the first:

```typescript
function renderSettingsAsMember() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(http.get('/api/auth/me', () => HttpResponse.json({ name: 'Member', email: 'member@example.com', role: 'member' })));
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <SettingsPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

// appended test
it('hides every rescrape/cancel/refresh button for a member', async () => {
  renderSettingsAsMember();
  const spanRow = await screen.findByRole('group', { name: 'span' });
  expect(within(spanRow).queryByRole('button', { name: /fetch open/i })).not.toBeInTheDocument();
  expect(within(spanRow).queryByRole('button', { name: /full refresh/i })).not.toBeInTheDocument();
  const mpRow = screen.getByRole('group', { name: 'myprocurement' });
  expect(within(mpRow).queryByRole('button', { name: /refresh awarded results/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test -w frontend -- src/test/App.test.tsx src/test/SettingsPage.test.tsx`
Expected: FAIL (routes not gated yet; `AdminUsersPage`/role checks not wired; `SettingsPage` doesn't know about roles yet)

- [ ] **Step 4: Update `App.tsx`**

Add imports:

```typescript
import { AuthProvider, useAuth } from './auth/AuthContext';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AdminUsersPage from './pages/AdminUsersPage';
```

Add a `RequireAuth` wrapper above `export default function App()`:

```typescript
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}
```

Wrap the existing return value's outer element in `<AuthProvider>`, and move `<Routes>` contents so unauthenticated routes are outside `RequireAuth` and everything else is inside it:

```typescript
export default function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              path="/*"
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </AuthProvider>
  );
}
```

Extract the existing `<div className="flex flex-col h-screen">...</div>` shell (everything currently inside `<BrowserRouter>`) into a new `AppShell()` component in the same file, with its inner `<Routes>` unchanged except adding:

```typescript
                  <Route
                    path="/admin/users"
                    element={
                      <RequireAdmin>
                        <AdminUsersPage />
                      </RequireAdmin>
                    }
                  />
```

and adding a nav link, in the same `<div className="mt-auto space-y-1">` block as `/settings`, but only rendered for admins:

```typescript
{useAuth().user?.role === 'admin' && (
  <NavLink to="/admin/users" className={navLinkClass}>Manage users</NavLink>
)}
```

(`useAuth()` inside `AppShell` is safe since `AppShell` only ever renders inside `RequireAuth`, which is inside `AuthProvider`.)

- [ ] **Step 5: Update `SettingsPage.tsx`**

Add the import: `import { useAuth } from '../auth/AuthContext';`

Inside `export default function SettingsPage()`, add `const { user } = useAuth();` near the top, then wrap the button-rendering block (`isRunningThis ? (...) : (<div className="flex gap-2">...)`) so the whole `<div className="flex gap-2">...</div>` (the non-cancel branch) only renders `{user?.role === 'admin' && ( ... )}`. The `Cancel` button (shown when `isRunningThis`) should also be admin-gated the same way, since cancelling is part of the same admin-only rescrape surface per the spec.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -w frontend -- src/test/App.test.tsx src/test/SettingsPage.test.tsx`
Expected: PASS

- [ ] **Step 7: Run the full frontend suite**

Run: `npm run test -w frontend`
Expected: PASS. Every other existing test file that renders `<App />` transitively (there are none besides `App.test.tsx` itself — other page tests render their page directly, e.g. `DashboardPage.test.tsx`, `TenderListPage.test.tsx`) is unaffected since those pages don't call `useAuth()`. Only `SettingsPage.test.tsx` needed the `AuthProvider`/admin-default change made in Step 2.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/App.tsx frontend/src/pages/SettingsPage.tsx frontend/src/test/App.test.tsx frontend/src/test/SettingsPage.test.tsx
git commit -m "feat: gate routes behind login, add admin-only nav/route, hide rescrape UI from members"
```

---

## Task 19: End-to-end verification in a real browser

Per `CLAUDE.md`'s E2E verification rule and the `e2e-playwright-verification` skill, this feature is entirely browser-visible (login, registration, passkey ceremonies) and must be checked live before considering it complete. Passkey ceremonies specifically require a virtual/platform authenticator, which a real browser session (not jsdom) can provide via Chrome's WebAuthn DevTools virtual authenticator.

- [ ] **Step 1: Start the stack**

Run: `docker compose up --build` (or `npm run dev -w backend` + `npm run dev -w frontend` for faster iteration), with real or dummy `MAILERSEND_API_KEY`/`ADMIN_EMAIL`/`SESSION_SECRET` values set in the environment first (a dummy MailerSend key will make the email `send()` call fail with a caught... actually it isn't caught — note this and, if verifying without a real MailerSend account, temporarily swap in `FakeEmailSender` in `index.ts` and read the OTP from server logs/a temporary `console.log`, then revert before committing).

- [ ] **Step 2: Verify the registration flow**

Using Playwright MCP tools (per the skill), navigate to `/register`, fill in name/email, submit, retrieve the OTP (from the admin email or the temporary log workaround above), enter it, then use Chrome's virtual authenticator (via `mcp__playwright__browser_evaluate` running the WebAuthn virtual authenticator CDP setup, or the Playwright MCP's built-in authenticator support if available) to complete the passkey ceremony. Confirm landing on the dashboard.

- [ ] **Step 3: Verify login**

Log out, go to `/login`, enter the same email, complete the passkey ceremony again, confirm landing back on the dashboard.

- [ ] **Step 4: Verify RBAC**

As a `member` account (register a second account with a different email — it won't match `ADMIN_EMAIL`, so it becomes `member`), confirm `/settings` shows no rescrape buttons and `/admin/users` is inaccessible (redirects home). As the `admin` account, confirm both work, and confirm demoting yourself when you're the only admin is refused (test this via the `/admin/users` UI if reachable, or via a direct API call).

- [ ] **Step 5: Report findings**

Note any UX rough edges found (e.g. unclear error messages) as follow-up items — do not silently fix scope beyond this plan without flagging it first.
