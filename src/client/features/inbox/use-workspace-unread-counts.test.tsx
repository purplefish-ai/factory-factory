// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { useWorkspaceUnreadCounts } from './use-workspace-unread-counts';

function Consumer({ workspaceId }: { workspaceId: string }) {
  const counts = useWorkspaceUnreadCounts('project');
  return <span>{counts.data?.[workspaceId] ?? 'pending'}</span>;
}

it('shares one project count request across consumers and fetches no message contents', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const requests: Array<{ path: string; input: unknown }> = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            requests.push({ path: op.path, input: op.input });
            observer.next({ result: { data: { first: 4, second: 2 } } });
            observer.complete();
          }),
    ],
  });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(() =>
      root.render(
        <trpc.Provider client={api} queryClient={client}>
          <QueryClientProvider client={client}>
            <Consumer workspaceId="first" />
            <Consumer workspaceId="second" />
          </QueryClientProvider>
        </trpc.Provider>
      )
    );
    await act(async () => {
      await vi.waitFor(() => expect(element.textContent).toBe('42'));
    });
    expect(requests).toEqual([
      { path: 'workspace.unreadMailCounts', input: { projectId: 'project' } },
    ]);
  } finally {
    await act(() => root.unmount());
    client.clear();
    element.remove();
    vi.unstubAllGlobals();
  }
});
