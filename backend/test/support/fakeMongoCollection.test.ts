import { describe, expect, it } from 'vitest';
import { FakeCollection } from './fakeMongoCollection.js';

interface Doc {
  _id: string;
  status: 'open' | 'closed';
  ministry: string | null;
  fieldCodes: string[];
  winners: Array<{ name: string; price: number | null }> | null;
  sources: Array<{ source: string }>;
  closingDate: string | null;
  advertisedDate: string | null;
}

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    _id: 'A', status: 'open', ministry: null, fieldCodes: [], winners: null,
    sources: [{ source: 'myprocurement' }], closingDate: null, advertisedDate: '2026-01-01',
    ...overrides,
  };
}

describe('FakeCollection', () => {
  it('findOne matches by exact field value, including _id', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', status: 'open' }), { upsert: true });
    expect((await col.findOne({ _id: 'A' }))?.status).toBe('open');
    expect(await col.findOne({ _id: 'NOPE' })).toBeNull();
  });

  it('replaceOne upserts, and updates in place on a second call with the same filter', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ status: 'open' }), { upsert: true });
    await col.replaceOne({ _id: 'A' }, doc({ status: 'closed' }), { upsert: true });
    expect((await col.find({}).toArray())).toHaveLength(1);
    expect((await col.findOne({ _id: 'A' }))?.status).toBe('closed');
  });

  it('find with $regex/$options matches case-insensitively', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', ministry: 'KEMENTERIAN BESAR' }), { upsert: true });
    const results = await col.find({ ministry: { $regex: 'besar', $options: 'i' } }).toArray();
    expect(results).toHaveLength(1);
  });

  it('find with $regex on a scalar array field matches if any element matches', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', fieldCodes: ['220801'] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', fieldCodes: ['010101'] }), { upsert: true });
    const results = await col.find({ fieldCodes: { $regex: '^22', $options: 'i' } }).toArray();
    expect(results.map((d) => d._id)).toEqual(['A']);
  });

  it('find with a dotted path auto-traverses arrays of subdocuments', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', sources: [{ source: 'span' }] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', sources: [{ source: 'kwsp' }] }), { upsert: true });
    const results = await col.find({ 'sources.source': 'span' }).toArray();
    expect(results.map((d) => d._id)).toEqual(['A']);
  });

  it('find with $ne/$not/$size treats the field as a whole array, not per-element', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', winners: [{ name: 'X', price: 1 }] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', winners: [] }), { upsert: true });
    await col.replaceOne({ _id: 'C' }, doc({ _id: 'C', winners: null }), { upsert: true });
    const results = await col.find({ winners: { $ne: null, $not: { $size: 0 } } }).toArray();
    expect(results.map((d) => d._id)).toEqual(['A']);
  });

  it('find with $elemMatch matches a subdocument array element on a nested field', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', winners: [{ name: 'SAFWORKS SDN BHD', price: 1 }] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', winners: [{ name: 'OTHER', price: 2 }] }), { upsert: true });
    const results = await col.find({ winners: { $elemMatch: { name: { $regex: 'safworks', $options: 'i' } } } }).toArray();
    expect(results.map((d) => d._id)).toEqual(['A']);
  });

  it('find with $gte/$lte on the same field applies both bounds, excluding null', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', closingDate: '2026-07-05' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', closingDate: '2026-07-15' }), { upsert: true });
    await col.replaceOne({ _id: 'C' }, doc({ _id: 'C', closingDate: '2026-07-25' }), { upsert: true });
    await col.replaceOne({ _id: 'D' }, doc({ _id: 'D', closingDate: null }), { upsert: true });
    const results = await col.find({ closingDate: { $gte: '2026-07-10', $lte: '2026-07-20' } }).toArray();
    expect(results.map((d) => d._id)).toEqual(['B']);
  });

  it('find with a projection returns only the requested fields plus _id', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', status: 'closed', ministry: 'MOF' }), { upsert: true });
    const results = await col.find({}, { projection: { status: 1, ministry: 1 } }).toArray();
    expect(results).toEqual([{ _id: 'A', status: 'closed', ministry: 'MOF' }]);
  });

  it('find with $or matches any subfilter', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', ministry: 'X' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', status: 'closed' }), { upsert: true });
    await col.replaceOne({ _id: 'C' }, doc({ _id: 'C' }), { upsert: true });
    const results = await col.find({ $or: [{ ministry: 'X' }, { status: 'closed' }] }).toArray();
    expect(results.map((d) => d._id).sort()).toEqual(['A', 'B']);
  });

  it('updateMany applies $set to every document matching the filter and reports modifiedCount', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', status: 'open' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', status: 'open' }), { upsert: true });
    const result = await col.updateMany({ _id: { $in: ['A', 'B'] } as unknown }, { $set: { status: 'closed' } });
    expect((await col.find({}).toArray()).every((d) => d.status === 'closed')).toBe(true);
    expect(result).toMatchObject({ modifiedCount: 2 });
  });

  it('countDocuments counts matches only', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', status: 'open' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', status: 'closed' }), { upsert: true });
    expect(await col.countDocuments({ status: 'open' })).toBe(1);
    expect(await col.countDocuments()).toBe(2);
  });

  it('distinct returns unique non-null values, flattening array fields including dotted paths', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', fieldCodes: ['010101', '220801'] }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', fieldCodes: ['010101'] }), { upsert: true });
    expect((await col.distinct('fieldCodes')).sort()).toEqual(['010101', '220801']);
    expect(await col.distinct('sources.source')).toEqual(['myprocurement']);
  });

  it('aggregate supports match/addFields/sort/facet/count for the paginated-query pipeline shape', async () => {
    const col = new FakeCollection<Doc>();
    await col.replaceOne({ _id: 'A' }, doc({ _id: 'A', advertisedDate: '2026-01-01' }), { upsert: true });
    await col.replaceOne({ _id: 'B' }, doc({ _id: 'B', advertisedDate: null }), { upsert: true });
    await col.replaceOne({ _id: 'C' }, doc({ _id: 'C', advertisedDate: '2026-06-01' }), { upsert: true });
    const pipeline = [
      { $match: {} },
      { $addFields: { __sortMissing: { $cond: [{ $eq: ['$advertisedDate', null] }, 1, 0] } } },
      { $sort: { __sortMissing: 1, advertisedDate: -1 } },
      {
        $facet: {
          items: [{ $skip: 0 }, { $limit: 2 }, { $project: { __sortMissing: 0 } }],
          totalCount: [{ $count: 'count' }],
        },
      },
    ];
    const [result] = await col.aggregate<{ items: Doc[]; totalCount: Array<{ count: number }> }>(pipeline).toArray();
    expect(result!.items.map((d) => d._id)).toEqual(['C', 'A']); // newest first, null pushed last
    expect(result!.totalCount[0]!.count).toBe(3);
    expect((result!.items[0] as unknown as Record<string, unknown>).__sortMissing).toBeUndefined(); // $project stripped it
  });

  it('deleteOne removes a matching document', async () => {
    const col = new FakeCollection<{ _id: string; name: string }>();
    await col.replaceOne({ _id: '1' }, { _id: '1', name: 'a' }, { upsert: true });
    await col.deleteOne({ _id: '1' });
    expect(await col.findOne({ _id: '1' })).toBeNull();
  });
});
