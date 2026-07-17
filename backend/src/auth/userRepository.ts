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
