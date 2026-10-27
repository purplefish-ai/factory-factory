import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import {
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
} from '@/client/lib/snapshot-to-workspace';
import {
  getProjectWorkspaceCacheReconciler,
  type ProjectWorkspaceCache,
  projectWorkspaceQueryOptions,
  workspaceDetailQueryOptions,
} from '@/client/lib/workspace-cache-reconciler';
import {
  WorkspaceSnapshotEntrySchema,
  type WorkspaceSnapshotEntry,
} from '@/shared/workspace-snapshot';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  makeWorkspaceSnapshotEntry,
  makeCompleteWorkspaceSnapshotEntry as complete,
} from '@/test-utils/workspace-snapshot';

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

function fixture() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
  const connection = owner.beginConnection();
  let resolve!: (cache: ProjectWorkspaceCache) => void;
  const options = projectWorkspaceQueryOptions(
    client,
    'proj-1',
    () =>
      new Promise<ProjectWorkspaceCache>((done) => {
        resolve = done;
      })
  );
  return {
    client,
    owner,
    connection,
    options,
    resolve: (cache: ProjectWorkspaceCache) => resolve(cache),
  };
}

describe('complete workspace summary adoption', () => {
  it('seeds canonical metadata before any HTTP row, and explicit null clears cached values', () => {
    const initial = projectSnapshotToWorkspace(complete());
    expect(initial).toMatchObject({
      githubIssueNumber: 42,
      creationSource: 'GITHUB_ISSUE',
      worktreePath: '/worktrees/live',
    });
    const cleared = projectSnapshotToWorkspace(
      complete({ githubIssueNumber: null, githubIssueUrl: null, worktreePath: null }),
      initial
    );
    expect(cleared).toMatchObject({
      githubIssueNumber: null,
      githubIssueUrl: null,
      worktreePath: null,
    });
    expect(cleared.createdAt).toBe(initial.createdAt);
  });

  it('uses canonical flat PR and status values without legacy reconstruction on complete rows', () => {
    const snapshot = complete({
      prUrl: 'https://github.com/org/repo/pull/7',
      prNumber: 7,
      prState: 'OPEN',
      kanbanColumn: 'DONE',
    });
    const row = projectSnapshotToWorkspace(snapshot);
    expect(row.prs).toEqual([]);
    expect(row.kanbanColumn).toBe('DONE');
    expect(row.statusReason).toEqual(snapshot.statusReason);
  });

  it.each(['RUNNING', 'PAUSED', 'COMPLETED', null] as const)(
    'adopts compact %s loop counters and clears unknown values',
    (status) => {
      const snapshot = complete({
        mode: 'AUTO_ITERATION',
        autoIterationStatus: status,
        autoIteration: {
          status,
          currentIteration: 7,
          maxIterations: 0,
          currentMetricSummary: 'score 95',
        },
      });
      const initial = projectSnapshotToWorkspace(snapshot);
      expect(initial.autoIteration).toEqual(snapshot.autoIteration);
      const unknown = projectSnapshotToWorkspace(
        complete({
          mode: 'AUTO_ITERATION',
          autoIterationStatus: null,
          autoIteration: {
            status: null,
            currentIteration: null,
            maxIterations: null,
            currentMetricSummary: null,
          },
        }),
        initial
      );
      expect(unknown.autoIteration).toEqual({
        status: null,
        currentIteration: null,
        maxIterations: null,
        currentMetricSummary: null,
      });
    }
  );

  it.each(['http-first', 'stream-first', 'resolution-gap'] as const)(
    'reconciles mixed complete/legacy membership and metadata at the actual %s cache commit',
    async (ordering) => {
      const f = fixture();
      const canonical = complete({ name: 'stream complete' });
      const legacy = makeWorkspaceSnapshotEntry({ workspaceId: 'legacy', name: 'stream legacy' });
      const response = {
        workspaces: [
          {
            ...projectSnapshotToWorkspace(makeWorkspaceSnapshotEntry()),
            name: 'stale HTTP',
            githubIssueNumber: 99,
            worktreePath: '/stale',
          },
          {
            ...projectSnapshotToWorkspace(legacy),
            name: 'stale legacy',
            githubIssueNumber: 55,
            worktreePath: '/legacy',
          },
          projectSnapshotToWorkspace(makeWorkspaceSnapshotEntry({ workspaceId: 'removed' })),
        ],
        reviewCount: 99,
      };
      const apply = () =>
        f.owner.apply(f.connection, {
          type: 'snapshot_full',
          projectId: 'proj-1',
          entries: [canonical, legacy],
          reviewCount: 3,
        });
      const request = f.client.fetchQuery({ ...f.options, staleTime: 0 });
      if (ordering === 'http-first') {
        f.resolve(response);
        await request;
        apply();
      } else if (ordering === 'stream-first') {
        apply();
        f.resolve(response);
        await request;
      } else {
        f.resolve(response);
        queueMicrotask(apply);
        await request;
      }
      const cache = f.client.getQueryData<ProjectWorkspaceCache>(f.options.queryKey)!;
      expect(cache.workspaces.map((row) => row.id)).toEqual(['ws-1', 'legacy']);
      expect(cache.workspaces[0]).toMatchObject({
        name: 'stream complete',
        githubIssueNumber: 42,
        worktreePath: '/worktrees/live',
      });
      expect(cache.workspaces[1]).toMatchObject({
        name: 'stream legacy',
        githubIssueNumber: 55,
        worktreePath: '/legacy',
      });
      expect(cache.reviewCount).toBe(3);
      expect(cache.workspaces[0]?.createdAt).toBeInstanceOf(Date);
    }
  );

  it('shares unchanged complete rows and keeps explicit loop nulls after a late HTTP repair', async () => {
    const f = fixture();
    const snapshot = complete({
      mode: 'AUTO_ITERATION',
      autoIterationStatus: 'RUNNING',
      autoIteration: {
        status: 'RUNNING',
        currentIteration: 8,
        maxIterations: 0,
        currentMetricSummary: 'score 95',
      },
    });
    const full = { type: 'snapshot_full' as const, projectId: 'proj-1', entries: [snapshot] };
    f.owner.apply(f.connection, full);
    const before = f.client.getQueryData<ProjectWorkspaceCache>(f.options.queryKey)!;
    f.owner.apply(f.connection, structuredClone(full));
    expect(f.client.getQueryData(f.options.queryKey)).toBe(before);
    const request = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    const unknown = complete({
      mode: 'AUTO_ITERATION',
      autoIterationStatus: null,
      autoIteration: {
        status: null,
        currentIteration: null,
        maxIterations: null,
        currentMetricSummary: null,
      },
    });
    f.owner.apply(f.connection, { type: 'snapshot_changed', workspaceId: 'ws-1', entry: unknown });
    f.resolve(before);
    await request;
    const after = f.client.getQueryData<ProjectWorkspaceCache>(f.options.queryKey)!;
    expect(after.workspaces[0]?.autoIteration).toEqual(unknown.autoIteration);
    expect(after.workspaces[0]?.createdAt).toBe(before.workspaces[0]?.createdAt);
    expect(after.workspaces[0]?.sessionSummaries).toBe(before.workspaces[0]?.sessionSummaries);
  });

  it('retains pre-baseline HTTP membership and connection retirement behavior', async () => {
    const f = fixture();
    f.owner.apply(f.connection, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: complete(),
    });
    const request = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve({ workspaces: [], reviewCount: 1 });
    await request;
    expect(f.client.getQueryData<ProjectWorkspaceCache>(f.options.queryKey)?.workspaces).toEqual(
      []
    );
    f.owner.apply(f.connection, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [complete()],
    });
    const obsolete = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.owner.retireConnection(f.connection);
    const next = f.owner.beginConnection();
    f.owner.apply(next, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [complete({ name: 'new connection' })],
    });
    f.resolve({ workspaces: [], reviewCount: 99 });
    await obsolete;
    expect(
      f.client.getQueryData<ProjectWorkspaceCache>(f.options.queryKey)?.workspaces[0]?.name
    ).toBe('new connection');
  });

  it('keeps complete summary metadata out of detail hydration while live fields still win HTTP ordering', async () => {
    const f = fixture();
    let resolve!: (detail: WorkspaceDetail) => void;
    const options = workspaceDetailQueryOptions(
      f.client,
      'ws-1',
      () =>
        new Promise<WorkspaceDetail>((done) => {
          resolve = done;
        })
    );
    const request = f.client.fetchQuery(options);
    const snapshot = complete({ name: 'live name' });
    f.owner.apply(f.connection, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [snapshot],
    });
    expect(f.client.getQueryData(options.queryKey)).toBeUndefined();
    const detail = unsafeCoerce<WorkspaceDetail>({
      ...projectSnapshotToWorkspace(snapshot),
      name: 'old HTTP name',
      worktreePath: '/detail-path',
      initErrorMessage: 'HTTP setup warning',
      prUpdatedAt: null,
      hasHadSessions: true,
      agentSessions: [{ id: 'session' }],
      terminalSessions: [{ id: 'terminal' }],
    });
    resolve(detail);
    await request;
    expect(f.client.getQueryData(options.queryKey)).toMatchObject({
      name: 'live name',
      worktreePath: '/detail-path',
      initErrorMessage: 'HTTP setup warning',
      agentSessions: detail.agentSessions,
      terminalSessions: detail.terminalSessions,
    });
  });

  it('rejects malformed version claims on the wire and defensively retains legacy projection for non-wire callers', () => {
    const { worktreePath: _omitted, ...malformed } = complete();
    expect(WorkspaceSnapshotEntrySchema.safeParse(malformed).success).toBe(false);
    const existing = { ...projectSnapshotToWorkspace(complete()), worktreePath: '/http-owned' };
    // The transport rejects this shape; imperative callers still must not treat its version as proof.
    const result = projectSnapshotToWorkspace(
      unsafeCoerce<WorkspaceSnapshotEntry>(malformed),
      existing
    );
    expect(result.worktreePath).toBe('/http-owned');
  });
});
