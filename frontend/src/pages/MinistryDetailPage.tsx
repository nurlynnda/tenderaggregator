import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchDashboard } from '../api/client';
import { formatMYR } from '../lib/format';

function barPct(value: number, max: number): number {
  return max > 0 ? (value / max) * 100 : 0;
}

export default function MinistryDetailPage() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard });
  if (!data) return null;

  const maxValue = Math.max(0, ...data.allMinistries.map((m) => m.totalValue));

  return (
    <div className="max-w-4xl space-y-6">
      <button type="button" onClick={() => navigate(-1)} className="text-blue-700 underline">
        ← Back to dashboard
      </button>
      <h1 className="font-semibold text-lg">Spend by Ministry — All {data.allMinistries.length} Ministries</h1>
      <div className="space-y-2">
        {data.allMinistries.map((m) => (
          <div key={m.ministry}>
            <div className="flex justify-between text-xs mb-1">
              <span>{m.ministry}</span>
              <span>{formatMYR(m.totalValue)} ({m.count})</span>
            </div>
            <div className="h-2 bg-gray-100 rounded">
              <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(m.totalValue, maxValue)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
