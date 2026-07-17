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
