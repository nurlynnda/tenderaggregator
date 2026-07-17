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
