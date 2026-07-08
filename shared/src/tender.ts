import { z } from 'zod';

export const TenderEventSchema = z.object({
  label: z.string(),
  date: z.string().nullable(),
  address: z.string().nullable(),
});
export type TenderEvent = z.infer<typeof TenderEventSchema>;

export const WinnerSchema = z.object({
  name: z.string().min(1),
  price: z.number().nullable(),
});
export type Winner = z.infer<typeof WinnerSchema>;

export const TenderSourceSchema = z.object({
  source: z.string().min(1),
  sourceId: z.string().min(1),
  sourceUrl: z.string().url(),
});
export type TenderSource = z.infer<typeof TenderSourceSchema>;

export const TenderSchema = z.object({
  dedupKey: z.string().min(1),
  referenceNo: z.string(),
  title: z.string().min(1),
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
  winners: z.array(WinnerSchema).nullable(),
  raw: z.record(z.string()),
  scrapedAt: z.string(),
  sources: z.array(TenderSourceSchema).min(1),
});
export type Tender = z.infer<typeof TenderSchema>;

export function computeDedupKey(referenceNo: string, fallback: string): string {
  const normalized = referenceNo.toUpperCase().replace(/\s+/g, '');
  return normalized.length > 0 ? normalized : fallback;
}

export const TenderPatchSchema = z.object({
  dedupKey: z.string().min(1),
  referenceNo: z.string(),
  title: z.string().min(1),
  status: z.enum(['open', 'closed']),
  procurementType: z.enum(['quotation', 'tender', 'requisition']),
  scrapedAt: z.string(),
  source: TenderSourceSchema,
  ministry: z.string().nullable().optional(),
  agency: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  fieldCodes: z.array(z.string()).optional(),
  advertisedDate: z.string().nullable().optional(),
  closingDate: z.string().nullable().optional(),
  indicativePrice: z.number().nullable().optional(),
  events: z.array(TenderEventSchema).optional(),
  winners: z.array(WinnerSchema).optional(),
  raw: z.record(z.string()).optional(),
});
export type TenderPatch = z.infer<typeof TenderPatchSchema>;
