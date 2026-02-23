import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';

const handlers = vi.hoisted(() => ({
  chat: vi.fn(),
  terminal: vi.fn(),
  setupTerminal: vi.fn(),
  devLogs: vi.fn(),
  postRunLogs: vi.fn(),
  snapshots: vi.fn(),
}));

vi.mock('@/backend/routers/websocket', () => ({
  createChatUpgradeHandler: vi.fn(() => handlers.chat),
  createTerminalUpgradeHandler: vi.fn(() => handlers.terminal),
  createSetupTerminalUpgradeHandler: vi.fn(() => handlers.setupTerminal),
  createDevLogsUpgradeHandler: vi.fn(() => handlers.devLogs),
  createPostRunLogsUpgradeHandler: vi.fn(() => handlers.postRunLogs),
  createSnapshotsUpgradeHandler: vi.fn(() => handlers.snapshots),
}));

vi.mock('@/backend/orchestration/domain-bridges.orchestrator', () => ({
  configureDomainBridges: vi.fn(),
}));

vi.mock('@/backend/orchestration/event-collector.orchestrator', () => ({
  configureEventCollector: vi.fn(),
  stopEventCollector: vi.fn(),
}));

vi.mock('@/backend/orchestration/snapshot-reconciliation.orchestrator', () => ({
  configureSnapshotReconciliation: vi.fn(),
  snapshotReconciliationService: {
    stop: vi.fn(async () => undefined),
  },
}));

vi.mock('@/backend/domains/ratchet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/domains/ratchet')>();
  return {
    ...actual,
    reconciliationService: {
      cleanupOrphans: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
      startPeriodicCleanup: vi.fn(),
      stopPeriodicCleanup: vi.fn(async () => undefined),
    },
  };
});

vi.mock('@/backend/interceptors', () => ({
  registerInterceptors: vi.fn(),
}));

vi.mock('@/backend/trpc/index', () => ({
  appRouter: {},
  createContext: vi.fn(() => () => ({})),
}));

vi.mock('@trpc/server/adapters/express', () => ({
  createExpressMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('@/backend/db', () => ({
  prisma: {
    $disconnect: vi.fn(async () => undefined),
  },
}));

import { createServer } from './server';

function createTestAppContext(): AppContext {
  return unsafeCoerce<AppContext>({
    services: {
      configService: {
        getBackendPort: () => 0,
        getEnvironment: () => 'test',
        getFrontendStaticPath: () => null,
        isDevelopment: () => false,
      },
      createLogger: () => ({
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      }),
      findAvailablePort: vi.fn(async (port: number) => port || 0),
      ratchetService: {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      },
      rateLimiter: {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      },
      schedulerService: {
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
      },
      acpTraceLogger: {
        cleanup: vi.fn(),
        cleanupOldLogs: vi.fn(),
      },
      sessionFileLogger: {
        cleanup: vi.fn(),
        cleanupOldLogs: vi.fn(),
      },
      sessionService: {
        stopAllClients: vi.fn(async () => undefined),
      },
      terminalService: {
        cleanup: vi.fn(),
      },
    },
  });
}

describe('server websocket upgrade routing', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  const createTestServer = () => {
    const server = createServer(undefined, createTestAppContext());
    servers.push(server);
    return server;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  it('routes /chat upgrades to chat handler', () => {
    const server = createTestServer();

    const request = {
      headers: { host: 'localhost:3001' },
      url: '/chat?sessionId=s1',
    };
    const socket = { destroy: vi.fn() };

    server.getHttpServer().emit('upgrade', request, socket, Buffer.alloc(0));

    expect(handlers.chat).toHaveBeenCalledOnce();
    expect(handlers.terminal).not.toHaveBeenCalled();
    expect(handlers.devLogs).not.toHaveBeenCalled();
    expect(handlers.snapshots).not.toHaveBeenCalled();
  });

  it('routes /terminal upgrades to terminal handler', () => {
    const server = createTestServer();

    const request = {
      headers: { host: 'localhost:3001' },
      url: '/terminal?workspaceId=ws-1',
    };
    const socket = { destroy: vi.fn() };

    server.getHttpServer().emit('upgrade', request, socket, Buffer.alloc(0));

    expect(handlers.terminal).toHaveBeenCalledOnce();
    expect(handlers.chat).not.toHaveBeenCalled();
    expect(handlers.devLogs).not.toHaveBeenCalled();
    expect(handlers.snapshots).not.toHaveBeenCalled();
  });

  it('routes /dev-logs and /snapshots upgrades to their handlers', () => {
    const server = createTestServer();

    const devLogsRequest = {
      headers: { host: 'localhost:3001' },
      url: '/dev-logs?workspaceId=ws-1',
    };
    const snapshotsRequest = {
      headers: { host: 'localhost:3001' },
      url: '/snapshots?projectId=project-1',
    };
    const socket = { destroy: vi.fn() };

    server.getHttpServer().emit('upgrade', devLogsRequest, socket, Buffer.alloc(0));
    server.getHttpServer().emit('upgrade', snapshotsRequest, socket, Buffer.alloc(0));

    expect(handlers.devLogs).toHaveBeenCalledOnce();
    expect(handlers.snapshots).toHaveBeenCalledOnce();
  });

  it('destroys socket for unknown upgrade paths', () => {
    const server = createTestServer();

    const request = {
      headers: { host: 'localhost:3001' },
      url: '/unknown-endpoint',
    };
    const socket = { destroy: vi.fn() };

    server.getHttpServer().emit('upgrade', request, socket, Buffer.alloc(0));

    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(handlers.chat).not.toHaveBeenCalled();
    expect(handlers.terminal).not.toHaveBeenCalled();
    expect(handlers.devLogs).not.toHaveBeenCalled();
    expect(handlers.snapshots).not.toHaveBeenCalled();
  });
});
