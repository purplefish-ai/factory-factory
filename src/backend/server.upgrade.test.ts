import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { prisma } from '@/backend/db';
import { reconciliationService } from '@/backend/domains/ratchet';
import { startInterceptors, stopInterceptors } from '@/backend/interceptors';
import { configureDomainBridges } from '@/backend/orchestration/domain-bridges.orchestrator';
import {
  configureEventCollector,
  stopEventCollector,
} from '@/backend/orchestration/event-collector.orchestrator';
import {
  configureSnapshotReconciliation,
  snapshotReconciliationService,
} from '@/backend/orchestration/snapshot-reconciliation.orchestrator';
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
  startInterceptors: vi.fn(async () => undefined),
  stopInterceptors: vi.fn(async () => undefined),
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

type TestHarnessOptions = {
  backendHost?: string;
  frontendStaticPath?: string | null;
  isRunScriptProxyEnabled?: boolean;
  requestedPortResult?: number;
};

function createTestHarness(options: TestHarnessOptions = {}) {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

  const requestedPortResult = options.requestedPortResult ?? 0;

  const services = {
    configService: {
      getBackendPort: () => 0,
      getBackendHost: () => options.backendHost,
      getEnvironment: () => 'test',
      getFrontendStaticPath: () => options.frontendStaticPath ?? null,
      isDevelopment: () => false,
      isRunScriptProxyEnabled: () => options.isRunScriptProxyEnabled ?? false,
      getCorsConfig: () => ({ allowedOrigins: ['http://localhost:3000'] }),
      getAppVersion: () => 'test-version',
    },
    createLogger: () => logger,
    findAvailablePort: vi.fn(async () => requestedPortResult),
    ratchetService: {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    },
    rateLimiter: {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      getApiUsageStats: vi.fn(() => ({
        requestsLastMinute: 0,
        isRateLimited: false,
      })),
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
  };

  return {
    context: unsafeCoerce<AppContext>({ services }),
    logger,
    services,
  };
}

function createTestAppContext(options: TestHarnessOptions = {}): AppContext {
  return createTestHarness(options).context;
}

describe('server websocket upgrade routing', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  const tempDirs: string[] = [];

  const createTestServer = (appContext = createTestAppContext(), requestedPort?: number) => {
    const server = createServer(requestedPort, appContext);
    servers.push(server);
    return server;
  };

  const createStaticFrontendDir = ({ withIndex }: { withIndex: boolean }) => {
    const dir = mkdtempSync(join(tmpdir(), 'server-static-test-'));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("test");\n');

    if (withIndex) {
      writeFileSync(join(dir, 'index.html'), '<html><body>factory-factory</body></html>\n');
    }

    return dir;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;

    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
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

  it('routes /setup-terminal and /post-run-logs upgrades to their handlers', () => {
    const server = createTestServer();

    const setupTerminalRequest = {
      headers: { host: 'localhost:3001' },
      url: '/setup-terminal?workspaceId=ws-1',
    };
    const postRunLogsRequest = {
      headers: { host: 'localhost:3001' },
      url: '/post-run-logs?workspaceId=ws-1',
    };
    const socket = { destroy: vi.fn() };

    server.getHttpServer().emit('upgrade', setupTerminalRequest, socket, Buffer.alloc(0));
    server.getHttpServer().emit('upgrade', postRunLogsRequest, socket, Buffer.alloc(0));

    expect(handlers.setupTerminal).toHaveBeenCalledOnce();
    expect(handlers.postRunLogs).toHaveBeenCalledOnce();
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

  it('destroys socket and does not throw for malformed Host header', () => {
    const server = createTestServer();

    const request = {
      headers: { host: '[!!]' },
      url: '/chat?sessionId=s1',
    };
    const socket = { destroy: vi.fn() };

    expect(() => {
      server.getHttpServer().emit('upgrade', request, socket, Buffer.alloc(0));
    }).not.toThrow();

    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(handlers.chat).not.toHaveBeenCalled();
    expect(handlers.terminal).not.toHaveBeenCalled();
    expect(handlers.devLogs).not.toHaveBeenCalled();
    expect(handlers.snapshots).not.toHaveBeenCalled();
  });

  it('destroys socket and does not throw for malformed upgrade URL', () => {
    const server = createTestServer();

    const request = {
      headers: { host: 'localhost:3001' },
      url: 'http://%',
    };
    const socket = { destroy: vi.fn() };

    expect(() => {
      server.getHttpServer().emit('upgrade', request, socket, Buffer.alloc(0));
    }).not.toThrow();

    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(handlers.chat).not.toHaveBeenCalled();
    expect(handlers.terminal).not.toHaveBeenCalled();
    expect(handlers.devLogs).not.toHaveBeenCalled();
    expect(handlers.snapshots).not.toHaveBeenCalled();
  });

  it('starts server and wires startup services', async () => {
    const harness = createTestHarness({
      requestedPortResult: 0,
    });
    const server = createTestServer(harness.context, 47_891);

    const endpoint = await server.start();

    expect(endpoint).toBe('http://localhost:0');
    expect(server.getPort()).toBe(0);
    expect(harness.services.findAvailablePort).toHaveBeenCalledWith(47_891);
    expect(harness.logger.warn).toHaveBeenCalledOnce();
    expect(configureDomainBridges).toHaveBeenCalledWith(harness.context.services);
    expect(configureEventCollector).toHaveBeenCalledWith(harness.context.services);
    expect(configureSnapshotReconciliation).toHaveBeenCalledWith(harness.context.services);
    expect(reconciliationService.cleanupOrphans).toHaveBeenCalledOnce();
    expect(reconciliationService.reconcile).toHaveBeenCalledOnce();
    expect(startInterceptors).toHaveBeenCalledOnce();
    expect(reconciliationService.startPeriodicCleanup).toHaveBeenCalledOnce();
    expect(harness.services.rateLimiter.start).toHaveBeenCalledOnce();
    expect(harness.services.schedulerService.start).toHaveBeenCalledOnce();
    expect(harness.services.ratchetService.start).toHaveBeenCalledOnce();
  });

  it('writes backend port to stdout when run script proxy mode is enabled', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const harness = createTestHarness({
      isRunScriptProxyEnabled: true,
      requestedPortResult: 0,
    });
    const server = createTestServer(harness.context, 0);

    await server.start();

    expect(writeSpy).toHaveBeenCalledWith('BACKEND_PORT:0\n');
    writeSpy.mockRestore();
  });

  it('logs startup reconciliation failures and continues starting', async () => {
    vi.mocked(reconciliationService.cleanupOrphans).mockRejectedValueOnce(
      new Error('cleanup failed')
    );
    vi.mocked(reconciliationService.reconcile).mockRejectedValueOnce(new Error('reconcile failed'));

    const harness = createTestHarness({ requestedPortResult: 0 });
    const server = createTestServer(harness.context, 0);

    await expect(server.start()).resolves.toBe('http://localhost:0');
    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to cleanup orphan sessions on startup',
      expect.any(Object)
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to reconcile workspaces on startup',
      expect.any(Object)
    );
  });

  it('rejects start when http server emits an error', async () => {
    const harness = createTestHarness({ requestedPortResult: 0 });
    const server = createTestServer(harness.context, 0);
    const httpServer = server.getHttpServer();

    vi.spyOn(httpServer, 'listen').mockImplementation(() => httpServer);

    const startPromise = server.start();
    await Promise.resolve();
    httpServer.emit('error', new Error('listen failed'));

    await expect(startPromise).rejects.toThrow('listen failed');
  });

  it('runs cleanup fan-out when server stops', async () => {
    const harness = createTestHarness();
    const server = createTestServer(harness.context);

    await server.stop();

    expect(stopInterceptors).toHaveBeenCalledOnce();
    expect(harness.services.sessionService.stopAllClients).toHaveBeenCalledWith(5000);
    expect(harness.services.terminalService.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.sessionFileLogger.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.acpTraceLogger.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.rateLimiter.stop).toHaveBeenCalledOnce();
    expect(harness.services.schedulerService.stop).toHaveBeenCalledOnce();
    expect(stopEventCollector).toHaveBeenCalledOnce();
    expect(snapshotReconciliationService.stop).toHaveBeenCalledOnce();
    expect(harness.services.ratchetService.stop).toHaveBeenCalledOnce();
    expect(reconciliationService.stopPeriodicCleanup).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it('serves static index fallback with no-cache headers and bypasses API routes', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: true });
    const harness = createTestHarness({ frontendStaticPath });
    const server = createTestServer(harness.context);

    const fallbackResponse = await request(server.getHttpServer()).get('/workspace/abc');
    const apiResponse = await request(server.getHttpServer()).get('/api/unknown');

    expect(fallbackResponse.status).toBe(200);
    expect(fallbackResponse.text).toContain('factory-factory');
    expect(fallbackResponse.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(fallbackResponse.headers.pragma).toBe('no-cache');
    expect(fallbackResponse.headers.expires).toBe('0');
    expect(apiResponse.status).toBe(404);
  });

  it('sets no-cache headers when index.html is requested directly', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: true });
    const server = createTestServer(createTestAppContext({ frontendStaticPath }));

    const response = await request(server.getHttpServer()).get('/index.html');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers.expires).toBe('0');
  });

  it('returns 503 when static fallback index.html is missing', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: false });
    const harness = createTestHarness({ frontendStaticPath });
    const server = createTestServer(harness.context);

    const response = await request(server.getHttpServer()).get('/workspace/xyz');

    expect(response.status).toBe(503);
    expect(response.text).toContain('Service temporarily unavailable');
    expect(harness.logger.debug).toHaveBeenCalledWith(
      'Failed to serve index.html for SPA fallback',
      expect.objectContaining({
        path: '/workspace/xyz',
        error: expect.any(String),
      })
    );
  });
});
