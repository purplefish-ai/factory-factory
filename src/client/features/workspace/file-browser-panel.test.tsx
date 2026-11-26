// @vitest-environment jsdom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FileBrowserPanel } from './file-browser-panel';

const { openTab } = vi.hoisted(() => ({ openTab: vi.fn() }));
vi.mock('./workspace-panel-context', () => ({
  useWorkspacePanelActions: () => ({ openTab }),
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

async function withFileBrowser(
  verify: (fixture: {
    container: HTMLElement;
    requests: string[];
    renameFile: (filename: string) => void;
  }) => Promise<void>
) {
  let filename = 'before.ts';
  const requests: string[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            if (op.path === 'workspace.listAllFiles') {
              const input = op.input as { workspaceId: string; query: string; match: string };
              requests.push(`${input.workspaceId}:${input.match}:${input.query}`);
              observer.next({
                result: { data: { hasWorktree: true, files: [`src/${filename}`] } },
              });
              observer.complete();
              return;
            }
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
  try {
    await act(() => {
      root.render(
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <FileBrowserPanel workspaceId="workspace-1" />
            </TooltipProvider>
          </QueryClientProvider>
        </trpc.Provider>
      );
    });
    await verify({
      container,
      requests,
      renameFile: (name) => {
        filename = name;
      },
    });
  } finally {
    await act(() => root.unmount());
    queryClient.clear();
  }
}

it('refreshes fresh root and expanded directory listings for this workspace', async () => {
  localStorage.setItem('file-tree-expanded-workspace-1', JSON.stringify(['src']));
  await withFileBrowser(async ({ container, requests, renameFile }) => {
    await vi.waitFor(() => expect(container.textContent?.match(/before.ts/g)).toHaveLength(2));
    expect(requests).toHaveLength(2);

    renameFile('after.ts');
    await act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Refresh file tree"]')?.click();
    });
    await vi.waitFor(() => expect(container.textContent?.match(/after.ts/g)).toHaveLength(2));
    expect(requests.filter((path) => path === 'workspace-1:')).toHaveLength(2);
    expect(requests.filter((path) => path === 'workspace-1:src')).toHaveLength(2);
  });
});

it('searches collapsed folders, opens a result, and returns to the tree after clearing', async () => {
  await withFileBrowser(async ({ container, requests, renameFile }) => {
    await vi.waitFor(() => expect(container.textContent).toContain('before.ts'));
    const folder = () => container.querySelector('button[aria-expanded="false"]');
    expect(folder()?.textContent).toBe('src');
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search files"]');
    expect(input).not.toBeNull();
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'bfr');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const result = () =>
      container.querySelector<HTMLButtonElement>('button[title="src/before.ts"]');
    await vi.waitFor(() => expect(result()).not.toBeNull());
    expect(requests).toContain('workspace-1:fuzzy:bfr');
    expect(requests).not.toContain('workspace-1:src');
    await act(() => result()?.click());
    expect(openTab).toHaveBeenCalledWith('file', 'src/before.ts', 'before.ts');

    renameFile('better-friend.ts');
    await act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh file search"]')?.click();
    });
    await vi.waitFor(() => expect(container.textContent).toContain('better-friend.ts'));

    await act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Clear file search"]')?.click();
    });
    expect(input?.value).toBe('');
    expect(folder()?.textContent).toBe('src');
  });
});

it('clears search on Escape after composition has ended', async () => {
  await withFileBrowser(async ({ container }) => {
    await vi.waitFor(() => expect(container.textContent).toContain('before.ts'));
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search files"]');
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'bfr');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(container.querySelector('ul[aria-label="File search results"]')).not.toBeNull()
    );

    await act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })
      );
    });
    expect(input?.value).toBe('bfr');
    await act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(input?.value).toBe('');
    expect(container.querySelector('button[aria-expanded="false"]')?.textContent).toBe('src');
  });
});
