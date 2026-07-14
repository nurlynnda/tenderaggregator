const SOURCES = [
  {
    name: 'MyProcurement',
    url: 'https://myprocurement.treasury.gov.my',
    description:
      "The Ministry of Finance's official government procurement portal — quotations, tenders, and requisitions advertised by federal ministries and agencies.",
  },
  {
    name: 'SPAN',
    url: 'https://www.span.gov.my/tender',
    description:
      'Suruhanjaya Perkhidmatan Air Negara (National Water Services Commission) — tenders for water and sewerage services regulation projects.',
  },
  {
    name: 'KWSP',
    url: 'https://www.kwsp.gov.my/en/corporate/procurement/tenders',
    description:
      'Kumpulan Wang Simpanan Pekerja (Employees Provident Fund) — procurement and tender notices published by KWSP.',
  },
];

export default function AboutPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-semibold text-lg">About</h1>

      <section className="space-y-2">
        <p>
          Malaysia Tender Aggregator collects publicly available government tender listings from
          several official Malaysian sources and brings them together in one searchable place —
          so you don't have to check each agency's website separately.
        </p>
        <p>
          You can search by keyword, filter by ministry, agency, category, source, or procurement
          type, and browse open, closed, and awarded tenders. Where a source publishes award
          results, the winning contractor and price are shown too.
        </p>
      </section>

      <section>
        <h2 className="font-semibold mb-3">Data Sources</h2>
        <div className="border border-[#e0e0e0] rounded-lg divide-y">
          {SOURCES.map((s) => (
            <div key={s.name} className="p-4">
              <a href={s.url} target="_blank" rel="noreferrer" className="font-medium text-blue-800 hover:underline">
                {s.name}
              </a>
              <p className="text-sm text-gray-600 mt-1">{s.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold mb-1">How it works</h2>
        <p className="text-sm text-gray-600">
          Data is fetched directly from each source's public listings on a regular schedule, and
          the same tender appearing in more than one source is de-duplicated by its reference
          number. Nothing here is entered or edited by hand — this site only mirrors what each
          source has already published.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold mb-1">Disclaimer</h2>
        <p className="text-sm text-gray-600">
          This is not an official government service and is not affiliated with the Ministry of
          Finance, SPAN, KWSP, or any other government body. It only re-publishes information that
          is already public. Always verify tender details, deadlines, and requirements on the
          original source before submitting a bid.
        </p>
      </section>
    </div>
  );
}
