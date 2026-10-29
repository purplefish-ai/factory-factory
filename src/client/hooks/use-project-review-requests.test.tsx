// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { actFlushSync } from '@/test-utils/react-act';
import { useProjectReviewRequests } from './use-project-review-requests';

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
