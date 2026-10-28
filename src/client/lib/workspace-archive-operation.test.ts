import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import { beginWorkspaceArchiveOperation } from '@/client/lib/workspace-archive-operation';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceQueryOptions,
} from '@/client/lib/workspace-cache-reconciler';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
  const token = owner.beginConnection();
  owner.apply(token, {
    type: 'snapshot_full',
    projectId: 'proj-1',
    entries: [entry(), entry({ workspaceId: 'ws-2' })],
  });
  const rows = () =>
    client.getQueryData<{ workspaces: { id: string; name: string }[] }>(owner.queryKey)!.workspaces;
  return { client, owner, token, rows };
}

describe('archive overlay cache ownership', () => {
  it('keeps pending rows hidden through accepted snapshots and HTTP, and restores latest failed row only', async () => {
    const f = fixture();
    const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'new accepted' }),
    });
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-2',
      entry: entry({ workspaceId: 'ws-2', name: 'unrelated new' }),
    });
    await f.client.fetchQuery({
      ...projectWorkspaceQueryOptions(f.client, 'proj-1', async () => ({
        workspaces: [projectSnapshotToWorkspace(entry({ name: 'stale HTTP' }))],
        reviewCount: 0,
      })),
      staleTime: 0,
    });
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    operation.settle(['ws-1']);
    expect(f.rows().map((row) => row.name)).toEqual(['new accepted', 'unrelated new']);
    f.client.clear();
  });

  it('does not resurrect an authoritative removal on rollback', () => {
    const f = fixture();
    const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    f.owner.apply(f.token, { type: 'snapshot_removed', workspaceId: 'ws-1' });
    operation.settle(['ws-1']);
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    f.client.clear();
  });

  it('uses eligible fallback HTTP for failed IDs and never rolls back an omitted full-baseline row', async () => {
    const f = fixture();
    const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    f.owner.retireConnection(f.token);
    await f.client.fetchQuery({
      ...projectWorkspaceQueryOptions(f.client, 'proj-1', async () => ({
        workspaces: [projectSnapshotToWorkspace(entry({ name: 'fresh fallback' }))],
        reviewCount: 7,
      })),
      staleTime: 0,
    });
    expect(f.rows()).toEqual([]);
    operation.settle(['ws-1']);
    expect(f.rows().map((row) => row.name)).toEqual(['fresh fallback']);
    const next = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    const connection = f.owner.beginConnection();
    f.owner.apply(connection, { type: 'snapshot_full', projectId: 'proj-1', entries: [] });
    next.settle(['ws-1']);
    expect(f.rows()).toEqual([]);
    f.client.clear();
  });

  it('does not share operations between projects on the same QueryClient', () => {
    const f = fixture();
    const other = getProjectWorkspaceCacheReconciler(f.client, 'proj-2');
    const connection = other.beginConnection();
    other.apply(connection, {
      type: 'snapshot_full',
      projectId: 'proj-2',
      entries: [entry({ projectId: 'proj-2', name: 'other project' })],
    });
    const before = f.client.getQueryData(other.queryKey);
    const operation = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    operation.settle(['ws-1']);
    expect(f.client.getQueryData(other.queryKey)).toBe(before);
    f.client.clear();
  });

  it('survives disconnect and a fresh HTTP/full base without clearing overlapping operations', async () => {
    const f = fixture();
    const first = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    const second = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    f.owner.retireConnection(f.token);
    await f.client.fetchQuery({
      ...projectWorkspaceQueryOptions(f.client, 'proj-1', async () => ({
        workspaces: [projectSnapshotToWorkspace(entry({ name: 'fallback' }))],
        reviewCount: 0,
      })),
      staleTime: 0,
    });
    expect(f.rows()).toEqual([]);
    const token = f.owner.beginConnection();
    f.owner.apply(token, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'reconnected' })],
    });
    first.settle(['ws-1']);
    expect(f.rows()).toEqual([]);
    second.settle(['ws-1']);
    expect(f.rows().map((row) => row.name)).toEqual(['reconnected']);
    f.client.clear();
  });

  it.each(['delta', 'full', 'fallback HTTP'])(
    'keeps overlap success fenced through an accepted %s base until the group ends',
    async (source) => {
      const f = fixture();
      const first = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1', 'ws-2']);
      const second = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1', 'ws-2']);
      first.settle(['ws-2']);
      const accepted = [
        entry({ name: 'late successful row' }),
        entry({ workspaceId: 'ws-2', name: 'latest failed row' }),
      ];
      if (source === 'delta') {
        for (const row of accepted) {
          f.owner.apply(f.token, {
            type: 'snapshot_changed',
            workspaceId: row.workspaceId,
            entry: row,
          });
        }
      } else if (source === 'full') {
        f.owner.apply(f.token, { type: 'snapshot_full', projectId: 'proj-1', entries: accepted });
      } else {
        f.owner.retireConnection(f.token);
        await f.client.fetchQuery({
          ...projectWorkspaceQueryOptions(f.client, 'proj-1', async () => ({
            workspaces: accepted.map((row) => projectSnapshotToWorkspace(row)),
            reviewCount: 0,
          })),
          staleTime: 0,
        });
      }
      expect(f.rows()).toEqual([]);
      second.settle(['ws-1', 'ws-2']);
      expect(f.rows().map((row) => [row.id, row.name])).toEqual([['ws-2', 'latest failed row']]);
      // The group has ended: a subsequent authoritative introduction is eligible again.
      const token = source === 'fallback HTTP' ? f.owner.beginConnection() : f.token;
      f.owner.apply(token, {
        type: 'snapshot_full',
        projectId: 'proj-1',
        entries: [entry({ name: 'legitimate later introduction' })],
      });
      expect(f.rows().map((row) => row.name)).toEqual(['legitimate later introduction']);
      const later = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
      later.settle(['ws-1']);
      expect(f.rows().map((row) => row.name)).toEqual(['legitimate later introduction']);
      f.client.clear();
    }
  );

  it('releases a finished ID fence while an unrelated archive remains pending', () => {
    const f = fixture();
    const first = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    const second = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    const unrelated = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-2']);
    first.settle([]);
    second.settle(['ws-1']);
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'later eligible introduction' }),
    });
    expect(f.rows().map((row) => row.name)).toEqual(['later eligible introduction']);
    unrelated.settle(['ws-2']);
    // The later delta reintroduced ws-1 after the still-eligible ws-2 base row.
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2', 'ws-1']);
    f.client.clear();
  });

  it('does not undo success when an overlapping archive fails, or change another QueryClient', () => {
    const f = fixture();
    const other = fixture();
    const first = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    const second = beginWorkspaceArchiveOperation(f.client, 'proj-1', ['ws-1']);
    first.settle([]);
    second.settle(['ws-1']);
    expect(f.rows().map((row) => row.id)).toEqual(['ws-2']);
    expect(other.rows().map((row) => row.id)).toEqual(['ws-1', 'ws-2']);
    f.client.clear();
    other.client.clear();
  });
});
