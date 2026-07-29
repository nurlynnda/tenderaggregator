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
      expiresAt: new Date(created.getTime() + ttlMs),
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
    await this.collection.replaceOne({ _id: id }, { ...doc, expiresAt: new Date(this.now().getTime() + ttlMs) });
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
  }

  async deleteByUserId(userId: string): Promise<void> {
    const docs = await this.collection.find({ userId }).toArray();
    for (const doc of docs) await this.collection.deleteOne({ _id: doc._id });
  }
}
