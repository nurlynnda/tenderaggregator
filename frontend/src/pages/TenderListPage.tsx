import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Tender } from '../api/types';
import { fetchFacets, fetchTenders } from '../api/client';
import Badge from '../components/Badge';
import DaysLeftBadge from '../components/DaysLeftBadge';
import FieldCodeFilter from '../components/FieldCodeFilter';
import { formatDate, formatSourceLabel, titleCase } from '../lib/format';

type SortBy = 'advertisedDate' | 'closingDate' | 'indicativePrice';

const FILTERS = [
  { key: 'ministry', label: 'Ministry', facet: 'ministries' },
  { key: 'agency', label: 'Agency', facet: 'agencies' },
  { key: 'category', label: 'Category', facet: 'categories' },
  { key: 'source', label: 'Source', facet: 'sources' },
  { key: 'procurementType', label: 'Type', facet: 'procurementTypes' },
] as const;

function FiltersIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M4 6h6M16 6h4M4 12h10M18 12h2M4 18h4M10 18h10" strokeLinecap="round" />
      <circle cx="12" cy="6" r="2" fill="currentColor" stroke="none" />
      <circle cx="14" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="8" cy="18" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-4 h-4 shrink-0 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
    </svg>
  );
}

const filterLabelClass = 'text-[10px] font-semibold text-gray-800';
const filterInputClass = 'border border-gray-300 rounded-lg px-3 py-2 text-[10px] w-full';

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

  const clearAll = () => {
    setSearchInput('');
    setSearch('');
    setContractorInput('');
    setContractor('');
    setFilters({});
    setFieldCode('');
    setClosingFrom('');
    setClosingTo('');
    setPage(1);
  };

  const pageTitle = hasWinners ? 'Awarded Tenders' : status === 'open' ? 'Open Tenders' : 'Closed Tenders';
  const pageDescription = hasWinners
    ? 'Browse and filter tenders that have been awarded, including winning contractors and prices.'
    : status === 'open'
      ? 'Browse and filter tenders that are currently open for bidding.'
      : 'Browse and filter tenders that have closed for bidding.';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">{pageTitle}</h1>
        <p className="text-xs text-gray-500 mt-1">{pageDescription}</p>
      </div>
      <div data-testid="filter-card" className="bg-white border border-gray-200 rounded-xl shadow-sm p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[10px] font-semibold text-gray-900">
            <FiltersIcon />
            Filters
          </div>
          <button type="button" onClick={clearAll} className="text-[10px] font-medium text-blue-700 hover:underline">
            Clear all
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <label className={`flex flex-col ${filterLabelClass} gap-1`}>
            Title or Reference No.
            <div className="relative">
              <SearchIcon />
              <input
                type="search"
                placeholder="Search title or reference no…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className={`${filterInputClass} pl-8`}
              />
            </div>
          </label>
          {hasWinners && (
            <label className={`flex flex-col ${filterLabelClass} gap-1`}>
              Contractor
              <div className="relative">
                <SearchIcon />
                <input
                  type="text"
                  placeholder="Search contractor…"
                  className={`${filterInputClass} pl-8`}
                  value={contractorInput}
                  onChange={(e) => setContractorInput(e.target.value)}
                />
              </div>
            </label>
          )}
          {FILTERS.map((f) => (
            <label key={f.key} className={`flex flex-col ${filterLabelClass} gap-1`}>
              {f.label}
              <select
                className={`${filterInputClass} truncate`}
                title={filters[f.key] || undefined}
                value={filters[f.key] ?? ''}
                onChange={(e) => {
                  setFilters((prev) => ({ ...prev, [f.key]: e.target.value }));
                  setPage(1);
                }}
              >
                <option value="">All</option>
                {(facets?.[f.facet] ?? []).map((v) => (
                  <option key={v} value={v}>
                    {f.key === 'source' ? formatSourceLabel(v) : f.key === 'procurementType' ? titleCase(v) : v}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <FieldCodeFilter value={fieldCode} onChange={(c) => { setFieldCode(c); setPage(1); }} />
          <label className={`flex flex-col ${filterLabelClass} gap-1`}>
            Closing From
            <input
              type="date"
              className={filterInputClass}
              value={closingFrom}
              onChange={(e) => { setClosingFrom(e.target.value); setPage(1); }}
            />
          </label>
          <label className={`flex flex-col ${filterLabelClass} gap-1`}>
            Closing To
            <input
              type="date"
              className={filterInputClass}
              value={closingTo}
              onChange={(e) => { setClosingTo(e.target.value); setPage(1); }}
            />
          </label>
        </div>
      </div>

      <div className="overflow-x-auto border border-gray-200 rounded-lg bg-white shadow-sm">
        <table className="data-table w-full text-[10px]">
          <thead className="bg-[#F3F2ED] text-[#1B1A18] text-left sticky top-0 z-10">
            <tr>
              <th className="px-3 py-3 uppercase tracking-wide w-full">Title</th>
              <th className="px-3 py-3 uppercase tracking-wide">Reference No</th>
              {!hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Type</th>}
              <th className="px-3 py-3 uppercase tracking-wide whitespace-nowrap min-w-[130px]">
                <button onClick={() => toggleSort('closingDate')} className="inline-flex items-center gap-1 whitespace-nowrap">
                  Closing Date{sortIndicator('closingDate')}
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M3 5h18l-7 8v6l-4 2v-8z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </th>
              <th className="px-3 py-3 uppercase tracking-wide">Field Code</th>
              <th className="px-3 py-3 uppercase tracking-wide">Source</th>
              {hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Contractor</th>}
              {hasWinners && <th className="px-3 py-3 uppercase tracking-wide">Price Won</th>}
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
                {!hasWinners && (
                  <td className="px-3 py-3">
                    {t.procurementType === null ? '—' : <Badge label={titleCase(t.procurementType)} colorKey={t.procurementType} />}
                  </td>
                )}
                <td className="px-3 py-3 whitespace-nowrap">
                  <div className="flex flex-col items-center gap-1">
                    <span>{formatDate(t.closingDate) ?? '—'}</span>
                    {status === 'open' && <DaysLeftBadge closingDate={t.closingDate} />}
                  </div>
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {t.fieldCodes.length === 0
                    ? '—'
                    : <Badge label={t.fieldCodes.length === 1 ? t.fieldCodes[0] : `${t.fieldCodes[0]} +${t.fieldCodes.length - 1}`} colorKey={t.fieldCodes[0]} />}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <div className="flex gap-1">
                    {t.sources.map((s) => <Badge key={s.source} label={formatSourceLabel(s.source)} colorKey={s.source} />)}
                  </div>
                </td>
                {hasWinners && <td className="px-3 py-3">{formatContractors(t.winners)}</td>}
                {hasWinners && <td className="px-3 py-3 whitespace-nowrap">{formatPricesWon(t.winners)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4">
        <span className="text-[10px] text-blue-700">{pageData?.total ?? 0} tenders</span>
        <button
          className="border border-blue-700 text-blue-700 rounded-md px-3 py-1 text-[10px] hover:bg-blue-50 disabled:opacity-50 disabled:text-gray-400 disabled:border-gray-300 disabled:hover:bg-transparent"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </button>
        <span className="text-[10px] text-blue-700">Page {page} of {totalPages}</span>
        <button
          className="border border-blue-700 text-blue-700 rounded-md px-3 py-1 text-[10px] hover:bg-blue-50 disabled:opacity-50 disabled:text-gray-400 disabled:border-gray-300 disabled:hover:bg-transparent"
          disabled={page >= totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
