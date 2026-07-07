import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { fetchTender } from '../api/client';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row py-2 border-b last:border-b-0">
      <div className="sm:w-1/3 font-semibold">{label}</div>
      <div className="sm:w-2/3">{value ?? '—'}</div>
    </div>
  );
}

export default function DetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isError } = useQuery({
    queryKey: ['tender', id],
    queryFn: () => fetchTender(id!),
    enabled: Boolean(id),
  });

  if (isError) return <div className="text-red-700">Tender not found.</div>;
  if (!data) return <div>Loading…</div>;
  const t = data.tender;

  return (
    <div className="max-w-4xl space-y-6">
      <Link to="/" className="text-blue-700 underline">← Back to all tenders</Link>
      <h1 className="text-xl font-bold">{t.title}</h1>
      <a
        href={t.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-blue-900 text-white rounded-md px-4 py-2"
      >
        View on official site ↗
      </a>

      <div className="border rounded-lg p-4">
        <Field label="Reference No" value={t.referenceNo} />
        <Field label="Status" value={<span className="capitalize">{t.status}</span>} />
        <Field label="Procurement Type" value={<span className="capitalize">{t.procurementType}</span>} />
        <Field label="Ministry" value={t.ministry} />
        <Field label="Agency" value={t.agency} />
        <Field label="Category" value={t.category} />
        <Field label="Field Codes" value={t.fieldCodes.length ? t.fieldCodes.join(', ') : null} />
        <Field label="Advertised" value={t.advertisedDate} />
        <Field label="Closing" value={t.closingDate} />
        <Field
          label="Indicative Price"
          value={t.indicativePrice === null ? null
            : `RM ${t.indicativePrice.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`}
        />
        <Field label="Source" value={t.source} />
        <Field label="Scraped At" value={t.scrapedAt} />
      </div>

      {t.events.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Events</h2>
          <table className="w-full text-sm border rounded-lg">
            <thead className="bg-gray-100 text-left">
              <tr><th className="px-3 py-2">Event</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Address</th></tr>
            </thead>
            <tbody>
              {t.events.map((e, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{e.label}</td>
                  <td className="px-3 py-2">{e.date ?? '—'}</td>
                  <td className="px-3 py-2">{e.address ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.alsoAvailableFrom.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Also listed on</h2>
          <ul className="list-disc pl-6">
            {data.alsoAvailableFrom.map((o) => (
              <li key={o.id}>
                <a href={o.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">{o.source}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
