import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { fetchScrapeStatus, triggerScrape } from '../api/client';

export default function ScrapeBanner() {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['scrape-status'],
    queryFn: fetchScrapeStatus,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 2000 : 10000),
  });
  const scrape = useMutation({
    mutationFn: triggerScrape,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['scrape-status'] }),
  });

  // When a run transitions out of 'running', refresh the tender list and facets.
  const prevState = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevState.current === 'running' && status?.state !== 'running') {
      queryClient.invalidateQueries({ queryKey: ['tenders'] });
      queryClient.invalidateQueries({ queryKey: ['facets'] });
    }
    prevState.current = status?.state;
  }, [status?.state, queryClient]);

  const running = status?.state === 'running';

  return (
    <div className="flex items-center gap-4">
      {running && (
        <span className="text-sm bg-blue-800 rounded-md px-3 py-1">
          Scraping {status?.source} — {status?.job}, page {status?.currentPage} / {status?.lastPage}
          {' '}(job {(status?.jobsCompleted ?? 0) + 1} / {status?.jobsTotal})
        </span>
      )}
      {status?.state === 'failed' && (
        <span className="text-sm bg-red-700 rounded-md px-3 py-1">Scrape failed: {status.error}</span>
      )}
      <button
        onClick={() => scrape.mutate()}
        disabled={running || scrape.isPending}
        className="bg-white text-blue-900 font-semibold text-sm rounded-md px-4 py-1.5 disabled:opacity-50"
      >
        Rescrape
      </button>
    </div>
  );
}
