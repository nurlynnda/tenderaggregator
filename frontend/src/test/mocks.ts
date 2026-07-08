import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { Facets, ScrapeStatus, Tender, TenderPage } from '../api/types';

export function makeTender(overrides: Partial<Tender> = {}): Tender {
  return {
    dedupKey: 'UTHM/54/P/02/023/2026',
    referenceNo: 'UTHM/54/P/02/023/2026',
    title: 'MENYELENGGARA PERALATAN MAKMAL',
    status: 'open', procurementType: 'quotation',
    ministry: 'KEMENTERIAN PENDIDIKAN TINGGI', agency: 'UTHM',
    category: 'Perkhidmatan Bukan Perunding', fieldCodes: ['060501'],
    advertisedDate: '2026-07-07', closingDate: '2026-07-17', indicativePrice: 28800,
    currency: 'MYR',
    events: [{ label: 'Lawatan Tapak', date: '2026-07-10', address: 'MAKMAL OR, KAJANG' }],
    winners: null,
    raw: {}, scrapedAt: '2026-07-07T12:00:00.000Z',
    sources: [{ source: 'myprocurement', sourceId: '1', sourceUrl: 'https://example.com/1' }],
    ...overrides,
  };
}

export const defaultPage: TenderPage = { items: [makeTender()], total: 1, page: 1, pageSize: 20 };
export const defaultFacets: Facets = {
  ministries: ['KEMENTERIAN PENDIDIKAN TINGGI'], agencies: ['UTHM'],
  categories: ['Perkhidmatan Bukan Perunding'], procurementTypes: ['quotation'],
  fieldCodes: ['060501'],
};
export const idleStatus: ScrapeStatus = { state: 'idle' };

export const handlers = [
  http.get('/api/tenders/facets', () => HttpResponse.json(defaultFacets)),
  http.get('/api/tenders/:refNo', ({ params }) =>
    params.refNo === 'UTHM/54/P/02/023/2026'
      ? HttpResponse.json({ tender: makeTender() })
      : HttpResponse.json({ error: 'tender not found' }, { status: 404 })),
  http.get('/api/tenders', () => HttpResponse.json(defaultPage)),
  http.get('/api/scrape/status', () => HttpResponse.json(idleStatus)),
  http.post('/api/scrape', () => HttpResponse.json({ started: true }, { status: 202 })),
];

export const server = setupServer(...handlers);
