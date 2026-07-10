import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelScrape, fetchScrapeStatus, fetchSources, triggerScrape } from '../api/client';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: sources } = useQuery({ queryKey: ['sources'], queryFn: fetchSources });
  const { data: status } = useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 2000 : 10000),
  });

  const invalidateAfterRun = () => {
    queryClient.invalidateQueries({ queryKey: ['scrape-status'] });
    queryClient.invalidateQueries({ queryKey: ['sources'] });
    queryClient.invalidateQueries({ queryKey: ['tenders'] });
    queryClient.invalidateQueries({ queryKey: ['facets'] });
  };
  const fetchMutation = useMutation({ mutationFn: triggerScrape, onSettled: invalidateAfterRun });
  const cancelMutation = useMutation({ mutationFn: cancelScrape, onSettled: invalidateAfterRun });

  const running = status?.state === 'running';

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-semibold text-lg">Settings</h1>
      <section>
        <h2 className="font-semibold mb-3">Data Sources</h2>
        <div className="border border-[#e0e0e0] rounded-lg divide-y">
          {(sources ?? []).map((s) => {
            const isRunningThis = running && status?.source === s.name;
            return (
              <div key={s.name} role="group" aria-label={s.name} className="p-4 flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium capitalize">{s.name}</div>
                  <div className="text-xs text-gray-500">
                    Last fetched: {s.lastScrapedAt ?? 'never'} · Full backfill: {s.lastArchiveBackfillAt ?? 'never'} · {s.total} tenders
                  </div>
                  {isRunningThis && (
                    <div className="text-xs text-blue-800 mt-1">
                      Fetching {status?.job} — page {status?.currentPage} / {status?.lastPage}
                      {' '}(job {(status?.jobsCompleted ?? 0) + 1} / {status?.jobsTotal})
                    </div>
                  )}
                  {status?.state === 'failed' && status?.source === s.name && (
                    <div className="text-xs text-red-700 mt-1">Scrape failed: {status.error}</div>
                  )}
                  {status?.state === 'cancelled' && status?.source === s.name && (
                    <div className="text-xs text-gray-500 mt-1">Cancelled</div>
                  )}
                </div>
                {isRunningThis ? (
                  <button
                    onClick={() => cancelMutation.mutate()}
                    disabled={cancelMutation.isPending}
                    className="bg-red-700 text-white text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => fetchMutation.mutate({ source: s.name, scope: 'open' })}
                      disabled={running || fetchMutation.isPending}
                      className="bg-blue-900 text-white text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
                    >
                      Fetch open
                    </button>
                    <button
                      onClick={() => fetchMutation.mutate({ source: s.name, scope: 'full' })}
                      disabled={running || fetchMutation.isPending}
                      className="border border-blue-900 text-blue-900 text-sm rounded-md px-3 py-1.5 disabled:opacity-50"
                    >
                      Full refresh
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
