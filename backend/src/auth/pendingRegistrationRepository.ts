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
    await this.collection.deleteOne({ _id: id });
  }
}
