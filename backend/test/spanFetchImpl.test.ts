import { describe, expect, it, vi } from 'vitest';
import { createSpanFetchImpl } from '../src/scrapers/span/spanFetchImpl.js';
import { SPAN_DIGICERT_INTERMEDIATE_PEM } from '../src/scrapers/span/digicertIntermediateCert.js';

describe('createSpanFetchImpl', () => {
  it('builds one Agent with the bundled intermediate cert plus the given root certs, and reuses it across calls', async () => {
    const constructedOptions: Array<{ connect: { ca: string[] } }> = [];
    class FakeAgent {
      constructor(opts: { connect: { ca: string[] } }) {
        constructedOptions.push(opts);
      }
    }
    const fetchImpl = vi.fn(async () => new Response('ok'));
    const f = createSpanFetchImpl({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      AgentCtor: FakeAgent as never,
      rootCertificates: ['root-cert-1', 'root-cert-2'],
    });

    await f('https://www.span.gov.my/tender/2026');
    await f('https://www.span.gov.my/tender/2025');

    expect(constructedOptions).toHaveLength(1); // one Agent instance, reused rather than rebuilt per call
    expect(constructedOptions[0].connect.ca).toEqual(['root-cert-1', 'root-cert-2', SPAN_DIGICERT_INTERMEDIATE_PEM]);
  });

  it('forwards url and init to the underlying fetch, attaching the dispatcher', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    class FakeAgent {}
    const f = createSpanFetchImpl({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      AgentCtor: FakeAgent as never,
      rootCertificates: [],
    });

    await f('https://www.span.gov.my/tender/2026', { headers: { 'User-Agent': 'bot' } });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.span.gov.my/tender/2026',
      expect.objectContaining({ headers: { 'User-Agent': 'bot' }, dispatcher: expect.any(FakeAgent) }),
    );
  });
});
