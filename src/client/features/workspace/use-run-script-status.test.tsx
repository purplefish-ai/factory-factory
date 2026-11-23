// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trpc } from '@/client/lib/trpc';
import {
  getProjectWorkspaceCacheReconciler,
  type WorkspaceConnection,
} from '@/client/lib/workspace-cache-reconciler';
import type { RunScriptStatus } from '@/shared/core';
import { makeWorkspaceSnapshotEntry as entry } from '@/test-utils/workspace-snapshot';
import { useRunScriptStatus } from './use-run-script-status';

let serverStatus: RunScriptStatus;
let requests: number;
let latencyMs: number;
let failures: number;
let queryClient: QueryClient;
let root: Root;

function Probe() {
  useRunScriptStatus('ws-1');
  return null;
}

async function mount() {
  const api = trpc.createClient({
    links: [
      () => () =>
        observable((observer) => {
          requests += 1;
          if (failures > 0) {
            failures -= 1;
            observer.error(TRPCClientError.from(new Error('Server unavailable')));
            return undefined;
          }
          // The response reflects the server when the request was made.
          const data = {
            status: serverStatus,
            pid: null,
            port: serverStatus === 'RUNNING' ? 4100 : null,
            proxyUrl: null,
            startedAt: null,
            hasRunScript: true,
            runScriptCommand: 'pnpm dev',
            runScriptPostRunCommand: null,
            runScriptCleanupCommand: null,
          };
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
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Publishes the server's status the way the snapshot stream does. */
async function stream(connection: WorkspaceConnection, status: RunScriptStatus) {
  serverStatus = status;
  const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
  await act(() => {
    owner.apply(connection, {
      type: 'snapshot_changed',
      workspaceId: 'ws-1',
      entry: entry({ runScriptStatus: status }),
    });
  });
}

async function connect(status: RunScriptStatus = 'IDLE') {
  const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
  const connection = owner.beginConnection();
  await act(() => {
    owner.apply(connection, {
      type: 'snapshot_full',
      projectId: 'proj-1',
      entries: [entry({ runScriptStatus: status })],
    });
  });
  return connection;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  serverStatus = 'IDLE';
  requests = 0;
  latencyMs = 0;
  failures = 0;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(() => root.unmount());
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useRunScriptStatus polling', () => {
  it('makes no requests for an idle dev server while the snapshot stream is live', async () => {
    await connect();
    await mount();
    await elapse(0);
    expect(requests).toBe(1);

    await elapse(60_000);
    expect(requests).toBe(1);
  });

  it('polls every 5 seconds while no snapshot stream carries the workspace', async () => {
    await mount();
    await elapse(0);
    expect(requests).toBe(1);

    await elapse(15_000);
    expect(requests).toBe(4);
  });

  it('refetches when the stream reports a start elsewhere and polls fast until it is idle again', async () => {
    const connection = await connect();
    await mount();
    await elapse(0);
    expect(requests).toBe(1);

    await stream(connection, 'STARTING');
    await elapse(0);
    expect(requests).toBe(2);

    await stream(connection, 'RUNNING');
    await elapse(0);
    expect(requests).toBe(3);
    // Port and tunnel arrive after RUNNING, and only HTTP carries them.
    await elapse(6000);
    expect(requests).toBe(6);

    await stream(connection, 'IDLE');
    await elapse(0);
    const afterStop = requests;
    expect(afterStop).toBe(7);
    await elapse(60_000);
    expect(requests).toBe(afterStop);
  });

  it('falls back to polling when the stream disconnects and stops again on reconnect', async () => {
    const connection = await connect();
    await mount();
    await elapse(60_000);
    expect(requests).toBe(1);

    const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
    await act(() => {
      owner.retireConnection(connection);
    });
    await elapse(10_000);
    expect(requests).toBe(3);

    await connect();
    await elapse(60_000);
    expect(requests).toBe(3);
  });

  it('refetches when a response that was in flight as the stream connected is stale', async () => {
    latencyMs = 1000;
    await mount();
    serverStatus = 'COMPLETED';
    await connect('COMPLETED');
    await elapse(2500);
    expect(requests).toBe(2);
  });

  it('keeps polling until a first read succeeds, even while the stream shows it idle', async () => {
    failures = 1;
    await connect();
    await mount();
    await elapse(0);
    expect(requests).toBe(1);
    await elapse(5000);
    expect(requests).toBe(2);
    await elapse(60_000);
    expect(requests).toBe(2);
  });

  it('compares the stream with the remount refetch once it settles, not cached data', async () => {
    const connection = await connect();
    await mount();
    await elapse(0);
    await act(() => root.unmount());

    latencyMs = 1000;
    await mount();
    // The server finishes while the remount read, which saw IDLE, is in flight.
    await stream(connection, 'COMPLETED');
    await elapse(2500);
    expect(requests).toBe(3);
  });

  it('refetches on reconnect when the baseline differs from what HTTP last showed', async () => {
    const connection = await connect();
    await mount();
    await elapse(0);
    const owner = getProjectWorkspaceCacheReconciler(queryClient, 'proj-1');
    await act(() => {
      owner.retireConnection(connection);
    });
    serverStatus = 'RUNNING';
    await connect('RUNNING');
    await elapse(0);
    expect(requests).toBe(2);
  });
});
