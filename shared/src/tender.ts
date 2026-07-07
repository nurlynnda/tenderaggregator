import { z } from 'zod';

export const TenderEventSchema = z.object({
  label: z.string(),
  date: z.string().nullable(),
  address: z.string().nullable(),
});
export type TenderEvent = z.infer<typeof TenderEventSchema>;

export const TenderSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceId: z.string().min(1),
  referenceNo: z.string(),
  dedupKey: z.string().min(1),
  title: z.string().min(1),
  sourceUrl: z.string().url(),
  status: z.enum(['open', 'closed']),
  procurementType: z.enum(['quotation', 'tender', 'requisition']),
  ministry: z.string().nullable(),
  agency: z.string().nullable(),
  category: z.string().nullable(),
  fieldCodes: z.array(z.string()),
  advertisedDate: z.string().nullable(),
  closingDate: z.string().nullable(),
  indicativePrice: z.number().nullable(),
  currency: z.literal('MYR'),
  events: z.array(TenderEventSchema),
  raw: z.record(z.string()),
  scrapedAt: z.string(),
});
export type Tender = z.infer<typeof TenderSchema>;

export function computeDedupKey(referenceNo: string, id: string): string {
  const normalized = referenceNo.toUpperCase().replace(/\s+/g, '');
  return normalized.length > 0 ? normalized : id;
}
