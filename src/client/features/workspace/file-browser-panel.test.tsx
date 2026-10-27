// @vitest-environment jsdom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { FileBrowserPanel } from './file-browser-panel';

vi.mock('./workspace-panel-context', () => ({
  useWorkspacePanel: () => ({ openTab: vi.fn() }),
}));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  notifyManager.setScheduler(queueMicrotask);
});
afterEach(() => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  document.body.innerHTML = '';
});

it('refreshes fresh root and expanded directory listings for this workspace', async () => {
  localStorage.setItem('file-tree-expanded-workspace-1', JSON.stringify(['src']));
  let filename = 'before.ts';
  const requests: string[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path !== 'workspace.listFiles') {
              throw new Error(`Unexpected query ${op.path}`);
            }
            const input = op.input as { workspaceId: string; path?: string };
            requests.push(`${input.workspaceId}:${input.path ?? ''}`);
            observer.next({
              result: {
                data: {
                  hasWorktree: true,
                  entries: input.path
                    ? [{ name: filename, type: 'file', path: `src/${filename}` }]
                    : [
                        { name: 'src', type: 'directory', path: 'src' },
                        { name: filename, type: 'file', path: filename },
                      ],
                },
              },
            });
            observer.complete();
          }),
    ],
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => {
    root.render(
      <trpc.Provider client={client} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <FileBrowserPanel workspaceId="workspace-1" />
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await vi.waitFor(() => expect(container.textContent?.match(/before.ts/g)).toHaveLength(2));
  expect(requests).toHaveLength(2);

  filename = 'after.ts';
  await act(() => {
    container.querySelector<HTMLButtonElement>('[title="Refresh file tree"]')?.click();
  });
  await vi.waitFor(() => expect(container.textContent?.match(/after.ts/g)).toHaveLength(2));
  expect(requests.filter((path) => path === 'workspace-1:')).toHaveLength(2);
  expect(requests.filter((path) => path === 'workspace-1:src')).toHaveLength(2);

  await act(() => root.unmount());
  queryClient.clear();
});
