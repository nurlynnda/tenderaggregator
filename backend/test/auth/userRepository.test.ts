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

  it('delete removes the user', async () => {
    const repo = new UserRepository(new FakeCollection<UserDoc>());
    const created = await repo.create({ name: 'A', email: 'a@example.com', role: 'member', credential });
    await repo.delete(created._id);
    expect(await repo.findById(created._id)).toBeNull();
  });
});
