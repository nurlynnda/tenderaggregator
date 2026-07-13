import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Tender } from '../api/types';
import { fetchFacets, fetchTenders } from '../api/client';
import Badge from '../components/Badge';
import DaysLeftBadge from '../components/DaysLeftBadge';
import FieldCodeFilter from '../components/FieldCodeFilter';
import { formatDate } from '../lib/format';

type SortBy = 'advertisedDate' | 'closingDate' | 'indicativePrice';

const FILTERS = [
  { key: 'ministry', label: 'Ministry', facet: 'ministries' },
  { key: 'agency', label: 'Agency', facet: 'agencies' },
  { key: 'category', label: 'Category', facet: 'categories' },
  { key: 'source', label: 'Source', facet: 'sources' },
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [contractorInput, setContractorInput] = useState(searchParams.get('contractor') ?? '');
  const [contractor, setContractor] = useState(searchParams.get('contractor') ?? '');
  const [filters, setFilters] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of FILTERS) {
      const v = searchParams.get(f.key);
      if (v) initial[f.key] = v;
    }
    return initial;
  });
  const [fieldCode, setFieldCode] = useState(searchParams.get('fieldCode') ?? '');
  const [closingFrom, setClosingFrom] = useState(searchParams.get('closingFrom') ?? '');
  const [closingTo, setClosingTo] = useState(searchParams.get('closingTo') ?? '');
  const [sortBy, setSortBy] = useState<SortBy>((searchParams.get('sortBy') as SortBy) ?? 'advertisedDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(
    (searchParams.get('sortOrder') as 'asc' | 'desc') ?? 'desc',
  );
  const [page, setPage] = useState(Number(searchParams.get('page') ?? '1'));
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const h = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [searchInput]);

  useEffect(() => {
    const h = setTimeout(() => { setContractor(contractorInput); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [contractorInput]);

  useEffect(() => {
    const next: Record<string, string> = {
      ...(search ? { search } : {}),
      ...(hasWinners && contractor ? { contractor } : {}),
      ...(fieldCode ? { fieldCode } : {}),
      ...(closingFrom ? { closingFrom } : {}),
      ...(closingTo ? { closingTo } : {}),
      ...(sortBy !== 'advertisedDate' ? { sortBy } : {}),
      ...(sortOrder !== 'desc' ? { sortOrder } : {}),
      ...(page !== 1 ? { page: String(page) } : {}),
      ...filters,
    };
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, contractor, fieldCode, closingFrom, closingTo, sortBy, sortOrder, page, filters, hasWinners]);

  const params: Record<string, string> = {
    search, status, sortBy, sortOrder, page: String(page),
    ...(hasWinners ? { hasWinners: 'true' } : {}),
    ...(hasWinners && contractor ? { contractor } : {}),
    ...(fieldCode ? { fieldCode } : {}),
    ...(closingFrom ? { closingFrom } : {}),
    ...(closingTo ? { closingTo } : {}),
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

  function toggleSave(key: string) {
    setSavedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function shareLink(referenceNo: string) {
    navigator.clipboard.writeText(`${window.location.origin}/tenders/${encodeURIComponent(referenceNo)}`);
  }

  return (
    <div className="space-y-4">
      <div data-testid="filter-card" className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <input
            type="search"
            placeholder="Search title or reference no…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="border border-[#e0e0e0] rounded-md px-3 py-2 w-72 text-[10px]"
          />
          {hasWinners && (
            <label className="flex flex-col text-[10px] gap-1">
              Contractor
              <input
                type="text"
                placeholder="Search contractor…"
                className="border border-[#e0e0e0] rounded-md px-2 py-2 w-40 text-[10px]"
                value={contractorInput}
                onChange={(e) => setContractorInput(e.target.value)}
              />
            </label>
          )}
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          {FILTERS.map((f) => (
            <label key={f.key} className="flex flex-col text-[10px] gap-1">
              {f.label}
              <select
                className="border border-[#e0e0e0] rounded-md px-2 py-2 w-40 truncate text-[10px]"
                title={filters[f.key] || undefined}
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
          <label className="flex flex-col text-[10px] gap-1">
            Closing from
            <input
              type="date"
              className="border border-[#e0e0e0] rounded-md px-2 py-2 text-[10px]"
              value={closingFrom}
              onChange={(e) => { setClosingFrom(e.target.value); setPage(1); }}
            />
          </label>
          <label className="flex flex-col text-[10px] gap-1">
            Closing to
            <input
              type="date"
              className="border border-[#e0e0e0] rounded-md px-2 py-2 text-[10px]"
              value={closingTo}
              onChange={(e) => { setClosingTo(e.target.value); setPage(1); }}
            />
          </label>
        </div>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white shadow-sm">
        <table className="data-table w-full text-[10px]">
          <thead className="bg-gray-100 text-left sticky top-0 z-10">
            <tr>
              <th className="px-3 py-3 uppercase tracking-wide w-full">Title</th>
              <th className="px-3 py-3 uppercase tracking-wide">Reference No</th>
              {!hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Ministry</th>}
              {!hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Type</th>}
              <th className="px-3 py-3 uppercase tracking-wide">
                <button onClick={() => toggleSort('closingDate')}>Closing Date{sortIndicator('closingDate')}</button>
              </th>
              <th className="px-3 py-3 uppercase tracking-wide">Field Code</th>
              <th className="px-3 py-3 uppercase tracking-wide">Source</th>
              {hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Contractor</th>}
              {hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Price Won</th>}
              <th className="px-3 py-3 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(pageData?.items ?? []).map((t, i) => (
              <tr
                key={t.dedupKey}
                onClick={() => navigate(`/tenders/${encodeURIComponent(t.referenceNo)}`)}
                className={`cursor-pointer hover:bg-blue-50 ${i % 2 === 1 ? 'bg-gray-50/50' : ''}`}
              >
                <td className="px-3 py-3 font-medium">{t.title}</td>
                <td className="px-3 py-3">
                  <div className="w-28 break-all">{t.referenceNo}</div>
                </td>
                {!hasWinners && <td className="px-3 py-3">{t.ministry ?? '—'}</td>}
                {!hasWinners && (
                  <td className="px-3 py-3">
                    {t.procurementType === null ? '—' : <Badge label={t.procurementType} />}
                  </td>
                )}
                <td className="px-3 py-3 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <span>{formatDate(t.closingDate) ?? '—'}</span>
                    <DaysLeftBadge closingDate={t.closingDate} />
                  </div>
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {t.fieldCodes.length === 0
                    ? '—'
                    : <Badge label={t.fieldCodes.length === 1 ? t.fieldCodes[0] : `${t.fieldCodes[0]} +${t.fieldCodes.length - 1}`} colorKey={t.fieldCodes[0]} />}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <div className="flex gap-1">
                    {t.sources.map((s) => <Badge key={s.source} label={s.source} />)}
                  </div>
                </td>
                {hasWinners && <td className="px-3 py-3">{formatContractors(t.winners)}</td>}
                {hasWinners && <td className="px-3 py-3 whitespace-nowrap">{formatPricesWon(t.winners)}</td>}
                <td className="px-3 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="text-[10px] text-blue-700 underline"
                      onClick={() => navigate(`/tenders/${encodeURIComponent(t.referenceNo)}`)}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      aria-pressed={savedKeys.has(t.dedupKey)}
                      className={`text-[10px] underline ${savedKeys.has(t.dedupKey) ? 'text-amber-600' : 'text-gray-500'}`}
                      onClick={() => toggleSave(t.dedupKey)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-[10px] text-gray-500 underline"
                      onClick={() => shareLink(t.referenceNo)}
                    >
                      Share
                    </button>
                  </div>
                </td>
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
