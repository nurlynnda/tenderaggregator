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

function formatContractors(winners: Tender['winners']): string {
  if (!winners || winners.length === 0) return '—';
  return winners.map((w) => w.name).join(', ');
}

function formatPricesWon(winners: Tender['winners']): string {
  if (!winners || winners.length === 0) return '—';
  return winners
    .map((w) => (w.price === null ? 'RM —' : `RM ${w.price.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`))
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
  const [contractorInput, setContractorInput] = useState('');
  const [contractor, setContractor] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [fieldCode, setFieldCode] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('advertisedDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const h = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  useEffect(() => {
    const h = setTimeout(() => { setContractor(contractorInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [contractorInput]);

  const params: Record<string, string> = {
    search, status, sortBy, sortOrder, page: String(page),
    ...(hasWinners ? { hasWinners: 'true' } : {}),
    ...(hasWinners && contractor ? { contractor } : {}),
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
          className="border border-[#e0e0e0] rounded-md px-3 py-2 w-72 text-[10px]"
        />
        {FILTERS.map((f) => (
          <label key={f.key} className="flex flex-col text-[10px] gap-1">
            {f.label}
            <select
              className="border border-[#e0e0e0] rounded-md px-2 py-2 text-[10px]"
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
        {hasWinners && (
          <label className="flex flex-col text-[10px] gap-1">
            Contractor
            <input
              type="text"
              placeholder="Search contractor…"
              className="border border-[#e0e0e0] rounded-md px-2 py-2 text-[10px]"
              value={contractorInput}
              onChange={(e) => setContractorInput(e.target.value)}
            />
          </label>
        )}
        <FieldCodeFilter value={fieldCode} onChange={(c) => { setFieldCode(c); setPage(1); }} />
      </div>

      <div className="overflow-x-auto border border-[#e0e0e0] rounded-lg">
        <table className="data-table w-full text-[10px]">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-3 py-2 uppercase tracking-wide">Title</th>
              <th className="px-3 py-2 uppercase tracking-wide">Reference No</th>
              <th className="px-3 py-2 uppercase tracking-wide">Ministry</th>
              <th className="px-3 py-2 uppercase tracking-wide">Type</th>
              <th className="px-3 py-2 uppercase tracking-wide">
                <button onClick={() => toggleSort('closingDate')}>Closing Date{sortIndicator('closingDate')}</button>
              </th>
              <th className="px-3 py-2 uppercase tracking-wide">Field Code</th>
              {hasWinners && <th className="px-3 py-2 uppercase tracking-wide">Contractor</th>}
              {hasWinners && <th className="px-3 py-2 uppercase tracking-wide">Price Won</th>}
            </tr>
          </thead>
          <tbody>
            {(pageData?.items ?? []).map((t) => (
              <tr
                key={t.dedupKey}
                onClick={() => navigate(`/tenders/${encodeURIComponent(t.referenceNo)}`)}
                className="cursor-pointer hover:bg-blue-50"
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
                {hasWinners && <td className="px-3 py-2">{formatContractors(t.winners)}</td>}
                {hasWinners && <td className="px-3 py-2 whitespace-nowrap">{formatPricesWon(t.winners)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4">
        <span className="text-xs">{pageData?.total ?? 0} tenders</span>
        <button
          className="border rounded-md px-3 py-1 text-sm disabled:opacity-50"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span className="text-xs">Page {page} of {totalPages}</span>
        <button
          className="border rounded-md px-3 py-1 text-sm disabled:opacity-50"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
