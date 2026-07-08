import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Tender } from '../api/types';
import { fetchFacets, fetchTenders } from '../api/client';
import FieldCodeFilter from '../components/FieldCodeFilter';

type SortBy = 'advertisedDate' | 'closingDate' | 'indicativePrice';

const FILTERS = [
  { key: 'ministry', label: 'Ministry', facet: 'ministries' },
  { key: 'agency', label: 'Agency', facet: 'agencies' },
  { key: 'category', label: 'Category', facet: 'categories' },
  { key: 'procurementType', label: 'Type', facet: 'procurementTypes' },
] as const;

function formatWinners(winners: Tender['winners']): string {
  if (!winners || winners.length === 0) return '—';
  return winners
    .map((w) => `${w.name} — ${w.price === null ? 'RM —' : `RM ${w.price.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`}`)
    .join(', ');
}

interface Props {
  status: 'open' | 'closed';
  hasWinners?: boolean;
}

export default function TenderListPage({ status, hasWinners = false }: Props) {
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [fieldCode, setFieldCode] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('advertisedDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const h = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  const params: Record<string, string> = {
    search, status, sortBy, sortOrder, page: String(page),
    ...(hasWinners ? { hasWinners: 'true' } : {}),
    ...(fieldCode ? { fieldCode } : {}),
    ...filters,
  };
  const { data: pageData } = useQuery({
    queryKey: ['tenders', params],
    queryFn: () => fetchTenders(params),
  });
  const { data: facets } = useQuery({ queryKey: ['facets'], queryFn: fetchFacets });

  const toggleSort = (col: SortBy) => {
    if (sortBy === col) setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortOrder('desc'); }
    setPage(1);
  };
  const sortIndicator = (col: SortBy) => (sortBy === col ? (sortOrder === 'asc' ? ' ▲' : ' ▼') : '');
  const totalPages = pageData ? Math.max(1, Math.ceil(pageData.total / pageData.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <input
          type="search"
          placeholder="Search title or reference no…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="border rounded-md px-3 py-2 w-72"
        />
        {FILTERS.map((f) => (
          <label key={f.key} className="flex flex-col text-sm gap-1">
            {f.label}
            <select
              className="border rounded-md px-2 py-2"
              value={filters[f.key] ?? ''}
              onChange={(e) => {
                setFilters((prev) => ({ ...prev, [f.key]: e.target.value }));
                setPage(1);
              }}
            >
              <option value="">All</option>
              {(facets?.[f.facet] ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        ))}
        <FieldCodeFilter value={fieldCode} onChange={(c) => { setFieldCode(c); setPage(1); }} />
      </div>

      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Reference No</th>
              <th className="px-3 py-2">Ministry</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">
                <button onClick={() => toggleSort('closingDate')}>Closing Date{sortIndicator('closingDate')}</button>
              </th>
              <th className="px-3 py-2">Field Code</th>
              {hasWinners && <th className="px-3 py-2">Won</th>}
            </tr>
          </thead>
          <tbody>
            {(pageData?.items ?? []).map((t) => (
              <tr
                key={t.dedupKey}
                onClick={() => navigate(`/tenders/${encodeURIComponent(t.referenceNo)}`)}
                className="border-t cursor-pointer hover:bg-blue-50"
              >
                <td className="px-3 py-2 font-medium max-w-xl">{t.title}</td>
                <td className="px-3 py-2 whitespace-nowrap">{t.referenceNo}</td>
                <td className="px-3 py-2">{t.ministry ?? '—'}</td>
                <td className="px-3 py-2 capitalize">{t.procurementType}</td>
                <td className="px-3 py-2 whitespace-nowrap">{t.closingDate ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {t.fieldCodes.length === 0
                    ? '—'
                    : t.fieldCodes.length === 1
                      ? t.fieldCodes[0]
                      : `${t.fieldCodes[0]} +${t.fieldCodes.length - 1}`}
                </td>
                {hasWinners && <td className="px-3 py-2">{formatWinners(t.winners)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4">
        <span>{pageData?.total ?? 0} tenders</span>
        <button
          className="border rounded-md px-3 py-1 disabled:opacity-50"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span>Page {page} of {totalPages}</span>
        <button
          className="border rounded-md px-3 py-1 disabled:opacity-50"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
