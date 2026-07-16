import * as cheerio from 'cheerio';

export interface LlmListingLink {
  sourceId: string;
  sourceUrl: string;
}

export function parseLlmListingHtml(html: string): LlmListingLink[] {
  const $ = cheerio.load(html);
  const links: LlmListingLink[] = [];
  const seen = new Set<string>();

  $('a[href*="/swasta/tender_detail/"]').each((_, el) => {
    const hrefRaw = $(el).attr('href') ?? '';
    const href = hrefRaw.split('#')[0]!;
    const idMatch = href.match(/\/swasta\/tender_detail\/(\d+)\/?/);
    if (!idMatch) return;
    const sourceId = idMatch[1]!;
    if (seen.has(sourceId)) return;
    seen.add(sourceId);
    links.push({ sourceId, sourceUrl: href });
  });

  return links;
}
