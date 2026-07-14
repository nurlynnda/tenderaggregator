import type { DashboardStats, Facets, ScrapeSource, ScrapeStatus, TenderDetail, TenderPage } from './types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export function fetchTenders(params: Record<string, string>): Promise<TenderPage> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '')).toString();
  return getJson(`/api/tenders${qs ? `?${qs}` : ''}`);
}

export function fetchFacets(): Promise<Facets> {
  return getJson('/api/tenders/facets');
}

export function fetchTender(refNo: string): Promise<TenderDetail> {
  return getJson(`/api/tenders/${encodeURIComponent(refNo)}`);
}

export function fetchScrapeStatus(): Promise<ScrapeStatus> {
  return getJson('/api/scrape/status');
}

export function fetchSources(): Promise<ScrapeSource[]> {
  return getJson('/api/sources');
}

export async function triggerScrape(params: { source?: string; scope?: 'open' | 'full' | 'results' } = {}): Promise<void> {
  const res = await fetch('/api/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (res.status === 409) throw new Error('scrape already running');
  if (!res.ok) throw new Error(`scrape trigger failed: ${res.status}`);
}

export async function cancelScrape(): Promise<void> {
  const res = await fetch('/api/scrape/cancel', { method: 'POST' });
  if (res.status === 409) throw new Error('nothing running');
  if (!res.ok) throw new Error(`cancel failed: ${res.status}`);
}

export function fetchDashboard(): Promise<DashboardStats> {
  return getJson('/api/dashboard');
}
