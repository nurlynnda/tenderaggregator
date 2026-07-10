import { rootCertificates } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { SPAN_DIGICERT_INTERMEDIATE_PEM } from './digicertIntermediateCert.js';

export interface SpanFetchImplDeps {
  fetchImpl?: typeof fetch;
  AgentCtor?: typeof Agent;
  rootCertificates?: readonly string[];
}

/** A fetch implementation scoped to SPAN alone, so the extra trusted certificate below never
 * weakens TLS verification for any other data source's requests. See digicertIntermediateCert.ts
 * for why this is needed. */
export function createSpanFetchImpl(deps: SpanFetchImplDeps = {}): typeof fetch {
  const fetchImpl = deps.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  const AgentCtor = deps.AgentCtor ?? Agent;
  const roots = deps.rootCertificates ?? rootCertificates;
  const agent = new AgentCtor({ connect: { ca: [...roots, SPAN_DIGICERT_INTERMEDIATE_PEM] } });

  return ((url: string, init?: RequestInit) =>
    fetchImpl(url, { ...init, dispatcher: agent } as RequestInit)) as typeof fetch;
}
