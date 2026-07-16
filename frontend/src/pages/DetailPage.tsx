import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchTender } from '../api/client';
import type { Tender } from '../api/types';
import { formatDate, formatSourceLabel } from '../lib/format';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row py-2 border-b last:border-b-0">
      <div className="sm:w-1/3 font-semibold">{label}</div>
      <div className="sm:w-2/3">{value ?? '—'}</div>
    </div>
  );
}

function formatWinners(winners: NonNullable<Tender['winners']>): string {
  return winners
    .map((w) => `${w.name} — ${w.price === null ? 'RM —' : `RM ${w.price.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`}`)
    .join(', ');
}

export default function DetailPage() {
  const navigate = useNavigate();
  const { refNo } = useParams<{ refNo: string }>();
  const { data, isError } = useQuery({
    queryKey: ['tender', refNo],
    queryFn: () => fetchTender(refNo!),
    enabled: Boolean(refNo),
  });

  if (isError) return <div className="text-red-700">Tender not found.</div>;
  if (!data) return <div>Loading…</div>;
  const t = data.tender;

  return (
    <div className="max-w-4xl space-y-6 text-[12px]">
      <button type="button" onClick={() => navigate(-1)} className="text-blue-700 underline">
        ← Back to all tenders
      </button>
      <h1 className="font-semibold">{t.title}</h1>
      <a
        href={t.sources[0]!.sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block bg-blue-900 text-white rounded-md px-4 py-2"
      >
        View on official site ↗
      </a>

      <div className="border border-[#e0e0e0] rounded-lg p-4">
        <Field label="Reference No" value={t.referenceNo} />
        <Field label="Status" value={<span className="capitalize">{t.status}</span>} />
        <Field
          label="Procurement Type"
          value={t.procurementType ? <span className="capitalize">{t.procurementType}</span> : null}
        />
        <Field label="Ministry" value={t.ministry} />
        <Field label="Agency" value={t.agency} />
        <Field label="Category" value={t.category} />
        <Field label="Field Codes" value={t.fieldCodes.length ? t.fieldCodes.join(', ') : null} />
        <Field label="Advertised" value={formatDate(t.advertisedDate)} />
        <Field label="Closing" value={formatDate(t.closingDate)} />
        <Field
          label="Indicative Price"
          value={t.indicativePrice === null ? null
            : `RM ${t.indicativePrice.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`}
        />
        {t.winners && t.winners.length > 0 && (
          <Field label="Winners" value={formatWinners(t.winners)} />
        )}
      </div>

      {t.events.length > 0 && (
        <div>
          <h2 className="font-semibold mb-2">Events</h2>
          <table className="data-table w-full border border-[#e0e0e0] rounded-lg">
            <thead className="bg-[#F3F2ED] text-[#1B1A18] text-left">
              <tr>
                <th className="px-3 py-2 uppercase tracking-wide">Event</th>
                <th className="px-3 py-2 uppercase tracking-wide">Date</th>
                <th className="px-3 py-2 uppercase tracking-wide">Address</th>
              </tr>
            </thead>
            <tbody>
              {t.events.map((e, i) => (
                <tr key={i}>
                  <td className="px-3 py-2">{e.label}</td>
                  <td className="px-3 py-2">{formatDate(e.date) ?? '—'}</td>
                  <td className="px-3 py-2">{e.address ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {t.sources.length > 1 && (
        <div>
          <h2 className="font-semibold mb-2">Also listed on</h2>
          <ul className="list-disc pl-6">
            {t.sources.map((s) => (
              <li key={s.source}>
                <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">{formatSourceLabel(s.source)}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
