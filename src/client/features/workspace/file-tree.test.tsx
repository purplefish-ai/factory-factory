// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FileTree } from './file-tree';
const query = vi.hoisted(() => ({
  data: undefined as undefined | { entries: []; hasWorktree: boolean },
  error: new Error('Offline'),
  isLoading: false,
  isFetching: false,
  refetch: vi.fn(),
}));
vi.mock('@/client/lib/trpc', () => ({
  trpc: { workspace: { listFiles: { useQuery: () => query } } },
}));
afterEach(() => {
  query.data = undefined;
  query.refetch.mockClear();
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
