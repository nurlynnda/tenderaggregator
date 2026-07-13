import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { fetchDashboard } from '../api/client';
import { formatMYR } from '../lib/format';

function barPct(value: number, max: number): number {
  return max > 0 ? (value / max) * 100 : 0;
}

export default function ContractorDetailPage() {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboard });
  if (!data) return null;

  const maxWins = Math.max(0, ...data.allContractors.map((c) => c.wins));

  return (
    <div className="max-w-4xl space-y-6">
      <button type="button" onClick={() => navigate(-1)} className="text-blue-700 underline">
        ← Back to dashboard
      </button>
      <h1 className="font-semibold text-lg">Top Contractors — All {data.allContractors.length} Contractors</h1>
      <div className="space-y-2">
        {data.allContractors.map((c, i) => (
          <div key={c.name}>
            <div className="flex justify-between text-xs mb-1">
              <span>{i + 1}. {c.name}</span>
              <span>{c.wins} wins · {formatMYR(c.totalValue)}</span>
            </div>
            <div className="h-2 bg-gray-100 rounded">
              <div className="h-2 bg-blue-800 rounded" style={{ width: `${barPct(c.wins, maxWins)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
