// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import {
  getProjectWorkspaceCacheReconciler,
  type WorkspaceConnection,
} from '@/client/lib/workspace-cache-reconciler';
import type { WorkspaceSnapshotEntry } from '@/shared/workspace-snapshot';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';
import { useWorkspaceSessions } from './use-workspace-sessions';

type Summary = WorkspaceSnapshotEntry['sessionSummaries'][number];

let serverSessions: Array<{ id: string; name: string }>;
let requests: number;
let latencyMs: number;
let rendered: string[] | undefined;
let queryClient: QueryClient;
let root: Root;

function Probe() {
  rendered = useWorkspaceSessions('ws-1').data?.map((session) => session.name ?? '');
  return null;
}

function summary(id: string, name: string, overrides: Partial<Summary> = {}): Summary {
  return {
    sessionId: id,
    name,
    workflow: 'default',
    model: null,
    persistedStatus: 'IDLE',
    runtimePhase: 'idle',
    processState: 'stopped',
    activity: 'IDLE',
    updatedAt: '2026-11-23T00:00:00Z',
    lastExit: null,
    ...overrides,
  };
}

function summaries() {
  return serverSessions.map((session) => summary(session.id, session.name));
}

async function mount() {
  const api = trpc.createClient({
    links: [
      () => () =>
        observable((observer) => {
          requests += 1;
          // The response reflects the server when the request was made.
          const data = serverSessions.map((session) => ({
            ...session,
            workspaceId: 'ws-1',
            workflow: 'default',
            model: null,
            status: 'IDLE',
            isWorking: false,
          }));
          const respond = () => {
            observer.next({ result: { data } });
            observer.complete();
          };
          if (latencyMs > 0) {
            const timer = setTimeout(respond, latencyMs);
            return () => clearTimeout(timer);
          }
          respond();
          return undefined;
        }),
    ],
  });
  root = createRoot(document.createElement('div'));
  await act(() =>
    root.render(
      <trpc.Provider client={api} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>
      </trpc.Provider>
    )
  );
  await elapse(0);
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function connect() {
  const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
  const connection = owner.beginConnection();
  await act(() => {
    owner.apply(connection, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ sessionSummaries: summaries() })],
    });
  });
  return connection;
}

async function stream(connection: WorkspaceConnection, sessionSummaries: Summary[]) {
  const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
  await act(() => {
    owner.apply(connection, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ sessionSummaries }),
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  serverSessions = [{ id: 's-1', name: 'Chat 1' }];
  requests = 0;
  latencyMs = 0;
  rendered = undefined;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useWorkspaceSessions polling', () => {
  it('polls every 10 seconds while no snapshot stream carries the workspace', async () => {
    await mount();
    expect(requests).toBe(1);
    await elapse(60_000);
    expect(requests).toBe(7);
  });

  it('polls every 30 seconds while the stream is live, for changes it does not push', async () => {
    await connect();
    await mount();
    expect(requests).toBe(1);
    await elapse(60_000);
    expect(requests).toBe(3);
  });

  it('refetches when the stream shows a session created, renamed or closed elsewhere', async () => {
    const connection = await connect();
    await mount();
    expect(rendered).toEqual(['Chat 1']);

    serverSessions = [...serverSessions, { id: 's-2', name: 'Chat 2' }];
    await stream(connection, summaries());
    await elapse(0);
    expect(requests).toBe(2);
    expect(rendered).toEqual(['Chat 1', 'Chat 2']);

    serverSessions = [{ id: 's-1', name: 'Renamed' }, serverSessions[1]!];
    await stream(connection, summaries());
    await elapse(0);
    expect(rendered).toEqual(['Renamed', 'Chat 2']);

    serverSessions = [serverSessions[0]!];
    await stream(connection, summaries());
    await elapse(0);
    expect(rendered).toEqual(['Renamed']);
    expect(requests).toBe(4);
  });

  it('does not refetch for runtime-only changes the stream already delivers', async () => {
    const connection = await connect();
    await mount();
    await stream(connection, [
      summary('s-1', 'Chat 1', { runtimePhase: 'running', activity: 'WORKING' }),
    ]);
    await stream(connection, [summary('s-1', 'Chat 1')]);
    await elapse(0);
    expect(requests).toBe(1);
  });

  it('refetches once a stream connects with sessions HTTP has not seen, then polls slowly', async () => {
    await mount();
    await elapse(25_000);
    expect(requests).toBe(3);

    serverSessions = [...serverSessions, { id: 's-2', name: 'Chat 2' }];
    await connect();
    await elapse(0);
    expect(requests).toBe(4);
    expect(rendered).toEqual(['Chat 1', 'Chat 2']);

    await elapse(29_000);
    expect(requests).toBe(4);
    await elapse(1000);
    expect(requests).toBe(5);
  });

  it('refetches when a response that was in flight as the stream connected is stale', async () => {
    latencyMs = 1000;
    await mount();
    serverSessions = [...serverSessions, { id: 's-2', name: 'Chat 2' }];
    await connect();
    await elapse(2500);
    expect(requests).toBe(2);
    expect(rendered).toEqual(['Chat 1', 'Chat 2']);
  });

  it('falls back to the 10 second poll while the stream is disconnected', async () => {
    const connection = await connect();
    await mount();
    const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
    await act(() => {
      owner.retireConnection(connection);
    });
    await elapse(30_000);
    expect(requests).toBe(4);
  });
});
