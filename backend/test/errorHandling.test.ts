import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { ScrapeManager } from '../src/scrape/manager.js';
import { TenderRepository } from '../src/storage/repository.js';
import type { SourceMetaDoc } from '../src/storage/repository.js';
import type { TenderDoc } from '../src/storage/tenderDoc.js';
import { FakeCollection } from './support/fakeMongoCollection.js';
import { PendingRegistrationRepository } from '../src/auth/pendingRegistrationRepository.js';
import { UserRepository } from '../src/auth/userRepository.js';
import { SessionRepository } from '../src/auth/sessionRepository.js';
import { FakeEmailSender } from '../src/auth/emailSender.js';
import { FakeWebAuthnService } from '../src/auth/webauthnService.js';
import { InMemoryRateLimiter } from '../src/auth/rateLimiter.js';
import type { PendingRegistrationDoc, SessionDoc, UserDoc } from '../src/auth/types.js';

describe('global error handling', () => {
  let sessions: SessionRepository;
  let users: UserRepository;
  let repo: TenderRepository;
  let tendersCollection: FakeCollection<TenderDoc>;

  beforeEach(() => {
    tendersCollection = new FakeCollection<TenderDoc>();
    repo = new TenderRepository(tendersCollection, new FakeCollection<SourceMetaDoc>());
    sessions = new SessionRepository(new FakeCollection<SessionDoc>());
    users = new UserRepository(new FakeCollection<UserDoc>());
  });

  async function loginAsAgent(targetApp: ReturnType<typeof createApp>) {
    const user = await users.create({
      name: 'member', email: 'member@example.com', role: 'member',
      credential: { id: 'member-cred', publicKey: 'pk', counter: 0 },
    });
    const agent = request.agent(targetApp);
    await agent.post('/api/auth/login/options').send({ email: user.email });
    await agent.post('/api/auth/login/verify').send({ email: user.email, response: {} });
    return agent;
  }

  it('returns a clean 500 (not a hang) when an async route handler rejects', async () => {
    const manager = new ScrapeManager([], repo);
    // Simulate an unexpected failure deep in a dependency (e.g. Mongo unavailable).
    manager.listSources = async () => {
      throw new Error('boom: mongo unavailable');
    };
    const app = createApp({
      repo,
      tendersCollection,
      manager,
      pendingRegistrations: new PendingRegistrationRepository(new FakeCollection<PendingRegistrationDoc>()),
      users,
      sessions,
      email: new FakeEmailSender(),
      webauthn: new FakeWebAuthnService(),
      rateLimiter: new InMemoryRateLimiter(),
      adminEmail: 'admin@example.com',
      sessionTtlMs: 1000 * 60 * 60,
      cookieSecret: 'test-secret',
    });

    const agent = await loginAsAgent(app);
    const res = await agent.get('/api/sources');
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});
