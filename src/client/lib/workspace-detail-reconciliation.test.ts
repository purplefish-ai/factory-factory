import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import {
  projectSnapshotToWorkspace,
  type WorkspaceDetail,
} from '@/client/lib/snapshot-to-workspace';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceQueryOptions,
  workspaceDetailQueryOptions,
} from '@/client/lib/workspace-cache-reconciler';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';

const clients: QueryClient[] = [];
function detail(overrides: Partial<WorkspaceDetail> = {}): WorkspaceDetail {
  return unsafeCoerce<WorkspaceDetail>({
    ...projectSnapshotToWorkspace(entry()),
    hasHadSessions: false,
    prUpdatedAt: null,
    initOutput: 'Setup output',
    initStartedAt: new Date('2026-01-01'),
    initCompletedAt: new Date('2026-01-02'),
    defaultSessionProvider: 'CODEX',
    agentSessions: [{ id: 'agent-1', provider: 'CODEX' }],
    terminalSessions: [{ id: 'terminal-1', name: 'Shell' }],
    ...overrides,
  });
}
function fixture(projectId = 'proj-1') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const owner = getProjectWorkspaceCacheReconciler(client, projectId);
  const token = owner.beginConnection();
  let resolve!: (value: WorkspaceDetail) => void;
  const options = workspaceDetailQueryOptions(
    client,
    'ws-1',
    () =>
      new Promise<WorkspaceDetail>((done) => {
        resolve = done;
      })
  );
  const full = (entries = [entry()]) =>
    owner.apply(token, { type: 'snapshot_full', projectId, entries });
  return {
    client,
    owner,
    token,
    options,
    full,
    resolve: (value: WorkspaceDetail) => resolve(value),
  };
}
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.clear();
  }
});

describe('workspace detail HTTP/stream commit ownership', () => {
  it('overlays the latest accepted entry at commit while hydrating detail-only fields', async () => {
    const f = fixture();
    const pending = f.client.fetchQuery(f.options);
    f.full();
    f.resolve(
      detail({ name: 'HTTP', worktreePath: '/ready/path', initErrorMessage: 'Setup warning' })
    );
    await Promise.resolve();
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({
        name: 'Newest',
        status: 'READY',
        runScriptStatus: 'RUNNING',
        hasHadSessions: true,
        mode: 'AUTO_ITERATION',
        autoIterationStatus: 'PAUSED',
        pendingRequestType: 'plan_approval',
      }),
    });
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
      name: 'Newest',
      status: 'READY',
      runScriptStatus: 'RUNNING',
      hasHadSessions: true,
      mode: 'AUTO_ITERATION',
      autoIterationStatus: 'PAUSED',
      pendingRequestType: 'plan_approval',
      worktreePath: '/ready/path',
      initErrorMessage: 'Setup warning',
      initOutput: 'Setup output',
      initStartedAt: new Date('2026-01-01'),
      initCompletedAt: new Date('2026-01-02'),
      defaultSessionProvider: 'CODEX',
      agentSessions: [{ id: 'agent-1', provider: 'CODEX' }],
      terminalSessions: [{ id: 'terminal-1', name: 'Shell' }],
    });
  });

  it('retains accepted deltas before a full baseline without granting list membership authority', async () => {
    const f = fixture();
    const pending = f.client.fetchQuery(f.options);
    f.owner.apply(f.token, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ name: 'Delta' }),
    });
    f.resolve(detail({ name: 'HTTP' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Delta' });
    await f.client.fetchQuery({
      ...projectWorkspaceQueryOptions(f.client, 'proj-1', () =>
        Promise.resolve({ workspaces: [], reviewCount: 0 })
      ),
      staleTime: 0,
    });
    expect(f.client.getQueryData(f.owner.queryKey)).toMatchObject({ workspaces: [] });
  });

  it('keeps absent full detail absent until HTTP supplies the fetched row', async () => {
    const f = fixture();
    f.full();
    expect(f.client.getQueryData(f.options.queryKey)).toBeUndefined();
    expect(f.client.getQueryCache().find({ queryKey: f.options.queryKey })).toBeUndefined();
    const pending = f.client.fetchQuery(f.options);
    expect(f.client.getQueryData(f.options.queryKey)).toBeUndefined();
    f.resolve(detail({ worktreePath: '/hydrated' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ worktreePath: '/hydrated' });
  });

  it('accepts initial HTTP that starts before the project connection is created', async () => {
    const client = new QueryClient();
    clients.push(client);
    let resolve!: (value: WorkspaceDetail) => void;
    const options = workspaceDetailQueryOptions(
      client,
      'ws-1',
      () =>
        new Promise<WorkspaceDetail>((done) => {
          resolve = done;
        })
    );
    const pending = client.fetchQuery(options);
    const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
    const token = owner.beginConnection();
    owner.apply(token, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ name: 'First stream' })],
    });
    resolve(detail({ name: 'HTTP' }));
    await pending;
    expect(client.getQueryData(options.queryKey)).toMatchObject({ name: 'First stream' });
  });

  it('ignores HTTP from a retired project generation and accepts fresh HTTP fallback', async () => {
    const f = fixture();
    f.client.setQueryData(f.options.queryKey, detail({ name: 'Cached' }));
    const pending = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.owner.retireConnection(f.token);
    f.resolve(detail({ name: 'Retired' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Cached' });
    const fallback = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve(detail({ name: 'Fallback' }));
    await fallback;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Fallback' });
  });

  it('rejects pre-connection HTTP after that first connection has retired', async () => {
    const client = new QueryClient();
    clients.push(client);
    let resolve!: (value: WorkspaceDetail) => void;
    const options = workspaceDetailQueryOptions(
      client,
      'ws-1',
      () =>
        new Promise<WorkspaceDetail>((done) => {
          resolve = done;
        })
    );
    const pending = client.fetchQuery(options);
    const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
    const token = owner.beginConnection();
    owner.retireConnection(token);
    owner.beginConnection();
    resolve(detail({ name: 'Retired bootstrap' }));
    await pending;
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  });

  it('scopes epochs to the response project and QueryClient', async () => {
    const f = fixture();
    const other = getProjectWorkspaceCacheReconciler(f.client, 'proj-2');
    const otherToken = other.beginConnection();
    const pending = f.client.fetchQuery(f.options);
    other.retireConnection(otherToken);
    other.beginConnection();
    const separate = fixture();
    separate.full([entry({ name: 'Other client' })]);
    f.full([entry({ name: 'This client' })]);
    f.resolve(detail({ name: 'HTTP' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'This client' });
  });

  it('accepts deliberately opened archived detail outside live membership', async () => {
    const f = fixture();
    f.full([]);
    const pending = f.client.fetchQuery(f.options);
    f.resolve(detail({ status: 'ARCHIVED', name: 'Archived HTTP' }));
    await pending;
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({
      status: 'ARCHIVED',
      name: 'Archived HTTP',
    });
    expect(f.client.getQueryData(f.owner.queryKey)).toMatchObject({ workspaces: [] });
  });

  it('consumes HTTP identity once so explicit reuse and optimistic writes keep their semantics', async () => {
    const f = fixture();
    f.full([entry({ name: 'Stream' })]);
    const pending = f.client.fetchQuery(f.options);
    const response = detail({ name: 'HTTP' });
    f.resolve(response);
    const returned = await pending;
    expect(returned).toBe(response);
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Stream' });
    f.client.setQueryData(f.options.queryKey, returned);
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'HTTP' });
    f.client.setQueryData(f.options.queryKey, { ...returned, name: 'Optimistic' });
    expect(f.client.getQueryData(f.options.queryKey)).toMatchObject({ name: 'Optimistic' });
  });

  it('preserves unchanged live references and Date identity during HTTP metadata repair', async () => {
    const f = fixture();
    const updatedAt = new Date('2026-01-03');
    const baseline = entry({ prUpdatedAt: updatedAt.toISOString() });
    const row = detail({ createdAt: new Date(baseline.createdAt), prUpdatedAt: updatedAt });
    f.client.setQueryData(f.options.queryKey, row);
    f.full([baseline]);
    const before = f.client.getQueryData<WorkspaceDetail>(f.options.queryKey)!;
    const pending = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve({
      ...row,
      name: 'Stale HTTP',
      prUpdatedAt: new Date('2025-01-01'),
      worktreePath: '/new/path',
    });
    await pending;
    const after = f.client.getQueryData<WorkspaceDetail>(f.options.queryKey)!;
    expect(after).not.toBe(before);
    expect(after.worktreePath).toBe('/new/path');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.prUpdatedAt).toBe(before.prUpdatedAt);
    expect(after.sessionSummaries).toBe(before.sessionSummaries);
    expect(after.prMonitoring).toBe(before.prMonitoring);
    const repair = f.client.fetchQuery({ ...f.options, staleTime: 0 });
    f.resolve({ ...after, name: 'Stale HTTP' });
    await repair;
    expect(f.client.getQueryData(f.options.queryKey)).toBe(after);
  });
});
