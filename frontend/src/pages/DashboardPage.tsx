import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchDashboard } from '../api/client';
import { formatMYR } from '../lib/format';

function barPct(value: number, max: number): number {
  return max > 0 ? (value / max) * 100 : 0;
}

export default function DashboardPage() {
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard });
  if (!data) return null;

  const maxMinistryValue = Math.max(0, ...data.byMinistry.map((m) => m.totalValue));
  const maxContractorValue = Math.max(0, ...data.topContractors.map((c) => c.totalValue));
  const maxYearValue = Math.max(0, ...data.byYear.map((y) => y.totalValue));

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="font-semibold text-lg">Dashboard</h1>

      <section className="flex gap-6">
        <div className="border border-[#e0e0e0] rounded-lg p-4 flex-1">
          <div className="text-xs text-gray-500">Total Awarded Value</div>
          <div className="text-lg font-semibold">{formatMYR(data.totalAwardedValue)}</div>
        </div>
        <div className="border border-[#e0e0e0] rounded-lg p-4 flex-1">
          <div className="text-xs text-gray-500">Total Awarded Tenders</div>
          <div className="text-lg font-semibold">{data.totalAwardedCount}</div>
        </div>
      </section>
      {data.excludedFromValueCount > 0 && (
        <div className="text-xs text-gray-500">
          Excludes {data.excludedFromValueCount} awards with no recorded price
        </div>
      )}

      <section>
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-semibold">Spend by Ministry</h2>
          <Link to="/dashboard/ministries" className="text-xs text-blue-700 underline">See more →</Link>
        </div>
        <div className="space-y-2">
          {data.byMinistry.map((m) => (
            <div key={m.ministry}>
              <div className="flex justify-between text-xs mb-1">
                <span>{m.ministry}</span>
                <span>{formatMYR(m.totalValue)} ({m.count})</span>
              </div>
              <div className="h-2 bg-gray-100 rounded">
                <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(m.totalValue, maxMinistryValue)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex justify-between items-center mb-3">
          <h2 className="font-semibold">Top Contractors</h2>
          <Link to="/dashboard/contractors" className="text-xs text-blue-700 underline">See more →</Link>
        </div>
        <div className="space-y-2">
          {data.topContractors.map((c, i) => (
            <div key={c.name}>
              <div className="flex justify-between text-xs mb-1">
                <span>{i + 1}. {c.name}</span>
                <span>{c.wins} wins · {formatMYR(c.totalValue)}</span>
              </div>
              <div className="h-2 bg-gray-100 rounded">
                <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(c.totalValue, maxContractorValue)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-semibold mb-3">Awarded Value by Year</h2>
        <div className="space-y-2">
          {data.byYear.map((y) => (
            <div key={y.year}>
              <div className="flex justify-between text-xs mb-1">
                <span>{y.year}</span>
                <span>{formatMYR(y.totalValue)}</span>
              </div>
              <div className="h-2 bg-gray-100 rounded">
                <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(y.totalValue, maxYearValue)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
