// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FileTree } from './file-tree';
import { FileTreeProvider } from './file-tree-context';
const query = vi.hoisted(() => ({
  data: undefined as undefined | { entries: []; hasWorktree: boolean },
  error: new Error('Offline') as Error | null,
  isLoading: false,
  isFetching: false,
  refetch: vi.fn(),
}));
const queryInput = vi.hoisted(() => vi.fn());
// Per-folder results; folders not listed here return `query`.
const nestedQueries = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    workspace: {
      listFiles: {
        useQuery: (input: { path?: string }) => {
          queryInput(input);
          return (input.path && nestedQueries.get(input.path)) || query;
        },
      },
    },
  },
}));
afterEach(() => {
  query.data = undefined;
  query.refetch.mockClear();
  queryInput.mockClear();
  nestedQueries.clear();
  query.error = new Error('Offline');
  vi.unstubAllGlobals();
});
it('retries a failed nested folder query in place', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(<FileTree workspaceId="w1" path="src" depth={1} onFileSelect={vi.fn()} />)
    );
    expect(queryInput).toHaveBeenCalledWith({ workspaceId: 'w1', path: 'src' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Offline');
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry'
    );
    expect(retry).toBeDefined();
    await act(() => retry?.click());
    expect(query.refetch).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
  }
});
it('retains cached folder data when a refetch fails', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.data = { entries: [], hasWorktree: true };
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(<FileTree workspaceId="w1" path="src" depth={1} onFileSelect={vi.fn()} />)
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('Empty directory');
  } finally {
    await act(() => root.unmount());
  }
});

it('keeps an unresolved offline first load in Loading rather than No files', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.error = null;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(() => root.render(<FileTree workspaceId="w1" onFileSelect={vi.fn()} />));
    expect(container.textContent).toContain('Loading…');
    expect(container.textContent).not.toContain('No files');
  } finally {
    await act(() => root.unmount());
  }
});

it('re-renders only the toggled folder, not the other expanded folders', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.setItem('file-tree-expanded-w1', JSON.stringify(['b']));
  query.error = null;
  query.data = {
    hasWorktree: true,
    entries: ['a', 'b', 'c'].map((name) => ({ name, type: 'directory', path: name })),
  } as never;
  for (const name of ['a', 'b', 'c']) {
    nestedQueries.set(name, { ...query, data: { entries: [], hasWorktree: true } });
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  const listingsOf = (path: string) =>
    queryInput.mock.calls.filter(([input]) => (input as { path?: string }).path === path).length;
  const row = (label: string) =>
    [...container.querySelectorAll('button')].find((button) => button.textContent === label);
  try {
    await act(() =>
      root.render(
        <FileTreeProvider workspaceId="w1">
          <FileTree workspaceId="w1" onFileSelect={vi.fn()} />
        </FileTreeProvider>
      )
    );
    const expandedRenders = listingsOf('b');
    expect(expandedRenders).toBeGreaterThan(0);
    await act(() => row('a')?.click());
    await act(() => row('c')?.click());
    expect(row('a')?.getAttribute('aria-expanded')).toBe('true');
    expect(listingsOf('b') - expandedRenders).toBe(0);
  } finally {
    await act(() => root.unmount());
    localStorage.clear();
  }
});
