// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getProjectWorkspaceCacheReconciler } from '@/client/lib/workspace-cache-reconciler';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';
import { useLiveWorkspaceSnapshot } from './use-live-workspace-snapshot';

let renders: Array<string | undefined>;
function Probe({ workspaceId }: { workspaceId: string }) {
  const status = useLiveWorkspaceSnapshot(workspaceId, (live) => live.runScriptStatus);
  renders.push(status);
  return null;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  renders = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('follows the selected field while the stream is live and is undefined otherwise', async () => {
  const client = new QueryClient();
  const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
  const root = createRoot(document.createElement('div'));
  try {
    await act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe workspaceId="ws-1" />
        </QueryClientProvider>
      )
    );
    expect(renders).toEqual([undefined]);

    const connection = owner.beginConnection();
    await act(() => {
      owner.apply(connection, { type: 'snapshot_full', projectId: 'proj-1', entries: [entry()] });
    });
    expect(renders.at(-1)).toBe('IDLE');

    // Unrelated changes to the entry do not re-render a field selector.
    const rendersBefore = renders.length;
    await act(() => {
      owner.apply(connection, {
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: entry({ isWorking: true }),
      });
    });
    expect(renders).toHaveLength(rendersBefore);

    await act(() => {
      owner.apply(connection, {
        type: 'snapshot_changed',
        workspaceId: 'ws-1',
        entry: entry({ runScriptStatus: 'STARTING' }),
      });
    });
    expect(renders.at(-1)).toBe('STARTING');

    await act(() => {
      owner.retireConnection(connection);
    });
    expect(renders.at(-1)).toBeUndefined();
  } finally {
    await act(() => root.unmount());
    client.clear();
  }
});
