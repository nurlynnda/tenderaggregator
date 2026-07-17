import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { AdminUser, CurrentUser, DashboardStats, Facets, Role, ScrapeSource, ScrapeStatus, TenderDetail, TenderPage } from './types';

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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`request failed: ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export async function registerRequest(params: { name: string; email: string }): Promise<void> {
  await postJson('/api/auth/register/request', params);
}

export async function verifyRegistrationOtp(otp: string): Promise<void> {
  await postJson('/api/auth/register/verify-otp', { otp });
}

export function getPasskeyRegistrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return postJson('/api/auth/register/passkey/options', {});
}

export function verifyPasskeyRegistration(response: RegistrationResponseJSON): Promise<{ user: CurrentUser }> {
  return postJson('/api/auth/register/passkey/verify', { response });
}

export function getLoginOptions(email: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return postJson('/api/auth/login/options', { email });
}

export function verifyLogin(email: string, response: AuthenticationResponseJSON): Promise<{ user: CurrentUser }> {
  return postJson('/api/auth/login/verify', { email, response });
}

export async function logout(): Promise<void> {
  await postJson('/api/auth/logout', {});
}

export function fetchMe(): Promise<CurrentUser> {
  return getJson('/api/auth/me');
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const body = await getJson<{ users: AdminUser[] }>('/api/admin/users');
  return body.users;
}

export async function updateUserRole(id: string, role: Role): Promise<AdminUser> {
  const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const message = await res
      .json()
      .then((body: { error?: string }) => body?.error)
      .catch(() => undefined);
    throw new Error(message ?? `update role failed: ${res.status}`);
  }
  return res.json() as Promise<AdminUser>;
}
