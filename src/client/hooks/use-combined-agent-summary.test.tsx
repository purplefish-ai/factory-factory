// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { useCombinedAgentSummary } from './use-combined-agent-summary';

let summary: { totalCount: number; failedCount: number } | undefined;
function Probe() {
  summary = useCombinedAgentSummary('project');
  return null;
}

it('refreshes the navigation badge every 30 seconds, not on the activity tier', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const paths: string[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            paths.push(op.path);
            observer.next({ result: { data: { totalCount: 2, failedCount: 1 } } });
            observer.complete();
          }),
    ],
  });
  const root = createRoot(document.createElement('div'));
  try {
    await act(() =>
      root.render(
        <trpc.Provider client={api} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <Probe />
          </QueryClientProvider>
        </trpc.Provider>
      )
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(summary).toEqual({ totalCount: 4, failedCount: 2 });
    expect(paths).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(paths.filter((path) => path === 'periodicTask.navigationSummary')).toHaveLength(3);
    expect(paths.filter((path) => path === 'automation.navigationSummary')).toHaveLength(3);
  } finally {
    await act(() => root.unmount());
    queryClient.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
