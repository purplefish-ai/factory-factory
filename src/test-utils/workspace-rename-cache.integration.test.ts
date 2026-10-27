import { createServer, type Server } from 'node:http';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { AppContext } from '@/backend/app-context';
import {
  createWorkspaceRename,
  type RenamedWorkspace,
} from '@/backend/orchestration/workspace-rename.orchestrator';
import {
  createSnapshotsUpgradeHandler,
  disposeSnapshotsHandlerState,
} from '@/backend/routers/websocket/snapshots.handler';
import { WorkspaceSnapshotStore } from '@/backend/services/workspace';
import { projectSnapshotToWorkspace } from '@/client/lib/snapshot-to-workspace';
import {
  getProjectWorkspaceCacheReconciler,
  projectWorkspaceQueryOptions,
  type ProjectWorkspaceCache,
} from '@/client/lib/workspace-cache-reconciler';
import { SnapshotServerMessageSchema } from '@/shared/workspace-snapshot';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

let queryClient: QueryClient | undefined;
let store: WorkspaceSnapshotStore | undefined;
let application: AppContext | undefined;
let server: Server | undefined;
let websocketServer: WebSocketServer | undefined;
let viewer: WebSocket | undefined;

afterEach(async () => {
  viewer?.terminate();
  viewer = undefined;
  if (websocketServer) {
    for (const socket of websocketServer.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => websocketServer!.close(() => resolve()));
    websocketServer = undefined;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
  if (application) {
    disposeSnapshotsHandlerState(application);
    application = undefined;
  }
  store?.clear();
  store = undefined;
  await queryClient?.cancelQueries();
  queryClient?.clear();
  queryClient = undefined;
});

it('streams the accepted canonical rename into the existing query cache before late HTTP commits', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient = client;
  const owner = getProjectWorkspaceCacheReconciler(client, 'proj-1');
  const token = owner.beginConnection();
  const snapshotStore = new WorkspaceSnapshotStore();
  store = snapshotStore;
  snapshotStore.configure({
    deriveFlowState: () => ({
      phase: 'NO_PR',
      ciObservation: 'NOT_FETCHED',
      hasActivePr: false,
      isWorking: false,
      shouldAnimateRatchetButton: false,
    }),
    deriveSidebarStatus: () => ({ activityState: 'IDLE', ciState: 'NONE' }),
  });
  snapshotStore.upsert(
    'ws-1',
    { projectId: 'proj-1', name: 'Before rename', nameUpdatedAt: 100, status: 'READY' },
    'seed',
    100
  );
  const before = snapshotStore.getByWorkspaceId('ws-1')!;
  const staleHTTP: ProjectWorkspaceCache = {
    workspaces: [{ ...projectSnapshotToWorkspace(before), worktreePath: '/http/metadata' }],
    reviewCount: 99,
  };
  let resolveHTTP!: (data: ProjectWorkspaceCache) => void;
  const options = projectWorkspaceQueryOptions(
    client,
    'proj-1',
    () =>
      new Promise<ProjectWorkspaceCache>((resolve) => {
        resolveHTTP = resolve;
      })
  );
  const http = client.fetchQuery(options);
  application = unsafeCoerce<AppContext>({
    services: {
      createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      configService: {
        getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
      },
      workspaceSnapshotStore: snapshotStore,
      workspaceQueryService: {
        getCachedReviewCount: () => 3,
        refreshReviewCountIfStale: () => Promise.resolve(3),
      },
    },
    lifecycle: { snapshotReconciliation: { waitForSeed: () => Promise.resolve() } },
  });
  const handler = createSnapshotsUpgradeHandler(application);
  const wss = new WebSocketServer({ noServer: true });
  websocketServer = wss;
  const httpServer = createServer();
  server = httpServer;
  const alive = new WeakMap<WebSocket, boolean>();
  httpServer.on('upgrade', (request, socket, head) =>
    handler(request, socket, head, new URL(request.url!, 'http://localhost'), wss, alive)
  );
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP snapshot fixture');
  }
  const messages = vi.fn();
  viewer = new WebSocket(`ws://127.0.0.1:${address.port}/snapshots?projectId=proj-1`, {
    origin: 'http://localhost:3000',
  });
  viewer.on('message', (raw) => {
    const message = SnapshotServerMessageSchema.parse(JSON.parse(raw.toString()));
    messages(message);
    owner.apply(token, message);
  });
  await vi.waitFor(() =>
    expect(client.getQueryData(options.queryKey)).toMatchObject({
      workspaces: [{ name: 'Before rename' }],
    })
  );
  const canonical = unsafeCoerce<RenamedWorkspace>({
    id: 'ws-1',
    name: 'Confirmed canonical name',
    status: 'READY',
    updatedAt: new Date(200),
  });
  const persist = vi.fn(() => Promise.resolve(canonical));
  const rename = createWorkspaceRename({
    rename: persist,
    publishAcceptedName: (...args) => snapshotStore.publishAcceptedName(...args),
  });
  expect(await rename.rename('ws-1', 'Requested name')).toEqual(canonical);
  expect(persist).toHaveBeenCalledExactlyOnceWith('ws-1', 'Requested name');
  await vi.waitFor(() =>
    expect(client.getQueryData(options.queryKey)).toMatchObject({
      workspaces: [{ name: canonical.name }],
      reviewCount: 3,
    })
  );
  expect(messages.mock.calls.map(([message]) => message.type)).toEqual([
    'snapshot_full',
    'snapshot_changed',
  ]);
  resolveHTTP(staleHTTP);
  await http;
  expect(client.getQueryData(options.queryKey)).toMatchObject({
    workspaces: [{ name: canonical.name, worktreePath: '/http/metadata' }],
    reviewCount: 3,
  });
});
