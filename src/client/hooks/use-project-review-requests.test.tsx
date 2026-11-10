// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { actFlushSync } from '@/test-utils/react-act';
import { REVIEW_REQUESTS_POLL_MS, useProjectReviewRequests } from './use-project-review-requests';

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});
const project = { id: 'p', githubOwner: 'o', githubRepo: 'r' };
function Consumer() {
  useProjectReviewRequests(project);
  return null;
}
let latest: ReturnType<typeof useProjectReviewRequests> | undefined;
let sidebar: ReturnType<typeof useProjectReviewRequests> | undefined;
function Probe() {
  latest = useProjectReviewRequests(project);
  return null;
}
function SidebarProbe() {
  sidebar = useProjectReviewRequests(project);
  return null;
}
function Providers({
  children,
  client,
  queryClient,
}: {
  children: ReactNode;
  client: ReturnType<typeof trpc.createClient>;
  queryClient: QueryClient;
}) {
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
it('shares page and navigation fetches and never uses an undefined global input', async () => {
  const requests = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests(op.input);
            observer.next({ result: { data: { prs: [], error: null } } });
            observer.complete();
          }),
    ],
  });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () =>
      root.render(
        <Providers client={client} queryClient={queryClient}>
          <Consumer />
        </Providers>
      )
    );
    await act(async () =>
      root.render(
        <Providers client={client} queryClient={queryClient}>
          <div>
            <Consumer />
            <Consumer />
          </div>
        </Providers>
      )
    );
    expect(requests.mock.calls).toEqual([[{ projectId: 'p' }]]);
  } finally {
    actFlushSync(() => root.unmount());
    queryClient.clear();
  }
});

it('polls on the server cache cadence and forces a fresh search on explicit refresh', async () => {
  const requests = vi.fn();
  const pr = (number: number) => ({
    number,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: 'o/r' },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests(op.input);
            const forced = (op.input as { forceRefresh?: boolean }).forceRefresh;
            observer.next({ result: { data: { prs: [pr(forced ? 2 : 1)], error: null } } });
            observer.complete();
          }),
    ],
  });
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () =>
      root.render(
        <Providers client={client} queryClient={queryClient}>
          <Probe />
          <SidebarProbe />
        </Providers>
      )
    );
    await act(() => vi.waitFor(() => expect(latest?.status).toBe('success')));
    const cached = queryClient.getQueryCache().getAll()[0];
    expect(cached?.observers[0]?.options).toMatchObject({
      staleTime: REVIEW_REQUESTS_POLL_MS,
      refetchInterval: REVIEW_REQUESTS_POLL_MS,
    });
    expect(REVIEW_REQUESTS_POLL_MS).toBe(120_000);
    expect(latest?.prs.map((row) => row.number)).toEqual([1]);

    // Repeated clicks while a refresh runs join it instead of queueing more gh searches.
    actFlushSync(() => {
      latest?.refresh();
      latest?.refresh();
    });
    // The forced result fills the shared page/sidebar key without another poll.
    await act(() =>
      vi.waitFor(() => {
        expect(latest?.prs.map((row) => row.number)).toEqual([2]);
        expect(sidebar?.prs.map((row) => row.number)).toEqual([2]);
      })
    );
    expect(requests.mock.calls).toEqual([
      [{ projectId: 'p' }],
      [{ projectId: 'p', forceRefresh: true }],
    ]);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  } finally {
    actFlushSync(() => root.unmount());
    queryClient.clear();
  }
});
