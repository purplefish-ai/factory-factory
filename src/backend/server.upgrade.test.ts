import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/backend/app-context';
import { prisma } from '@/backend/db';
import { startInterceptors, stopInterceptors } from '@/backend/interceptors';
import { configureDomainBridges } from '@/backend/orchestration/domain-bridges.orchestrator';
import {
  configureEventCollector,
  stopEventCollector,
} from '@/backend/orchestration/event-collector.orchestrator';
import { reconciliationService } from '@/backend/orchestration/reconciliation.service';
import {
  configureSnapshotReconciliation,
  snapshotReconciliationService,
} from '@/backend/orchestration/snapshot-reconciliation.orchestrator';
import { recoverStaleArchivingWorkspaces } from '@/backend/orchestration/workspace-archive.orchestrator';
import { runScriptStateMachine } from '@/backend/services/run-script';
import { workspaceGitStateService } from '@/backend/services/workspace-git-state.service';
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

vi.mock('@/backend/orchestration/workspace-archive.orchestrator', () => ({
  recoverStaleArchivingWorkspaces: vi.fn(async () => ({ archived: [], failed: [] })),
}));

vi.mock('@/backend/orchestration/reconciliation.service', () => ({
  reconciliationService: {
    cleanupOrphans: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    startPeriodicCleanup: vi.fn(),
    stopPeriodicCleanup: vi.fn(async () => undefined),
  },
}));

vi.mock('@/backend/services/run-script', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/backend/services/run-script')>();
  return {
    ...actual,
    runScriptStateMachine: {
      ...actual.runScriptStateMachine,
      removeAllListeners: vi.fn(),
      on: vi.fn(),
      recoverStaleStates: vi.fn(async () => undefined),
    },
  };
});

vi.mock('@/backend/services/workspace-git-state.service', () => ({
  workspaceGitStateService: {
    stop: vi.fn(),
  },
}));

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
};

function createTestHarness(options: TestHarnessOptions = {}) {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };

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
      getDatabasePath: () => '/tmp/test.db',
      getDatabasePathFromEnv: () => undefined,
    },
    createLogger: () => logger,
    findAvailablePort: vi.fn(async (startPort: number) => startPort),
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
      recoverStaleSessionStates: vi.fn(async () => 0),
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

async function occupyPort(port = 0): Promise<{ port: number; server: NetServer }> {
  const server = createNetServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected occupied TCP server to have a numeric port');
  }

  return { port: address.port, server };
}

async function closeNetServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForHttpServerToListen(server: ReturnType<typeof createServer>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.getHttpServer().listening) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Expected HTTP server to start listening');
}

async function occupyConsecutivePorts(
  count: number
): Promise<{ startPort: number; servers: NetServer[] }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const servers: NetServer[] = [];

    try {
      const first = await occupyPort();
      const startPort = first.port;
      servers.push(first.server);

      if (startPort + count - 1 > 65_535) {
        await Promise.allSettled(servers.map(closeNetServer));
        continue;
      }

      for (let offset = 1; offset < count; offset++) {
        const occupied = await occupyPort(startPort + offset);
        servers.push(occupied.server);
      }

      return { startPort, servers };
    } catch (error) {
      await Promise.allSettled(servers.map(closeNetServer));

      if (attempt === 49) {
        throw error;
      }
    }
  }

  throw new Error('Could not occupy a consecutive TCP port range');
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
    const harness = createTestHarness();
    const server = createTestServer(harness.context, 0);

    const endpoint = await server.start();

    expect(endpoint).toBe('http://localhost:0');
    expect(server.getPort()).toBe(0);
    expect(harness.services.findAvailablePort).not.toHaveBeenCalled();
    expect(harness.logger.warn).not.toHaveBeenCalled();
    expect(configureDomainBridges).toHaveBeenCalledWith(harness.context.services);
    expect(configureEventCollector).toHaveBeenCalledWith(harness.context.services);
    expect(configureSnapshotReconciliation).toHaveBeenCalledWith(harness.context.services);
    expect(reconciliationService.cleanupOrphans).toHaveBeenCalledOnce();
    expect(harness.services.sessionService.recoverStaleSessionStates).toHaveBeenCalledOnce();
    expect(reconciliationService.reconcile).toHaveBeenCalledOnce();
    expect(runScriptStateMachine.recoverStaleStates).toHaveBeenCalledOnce();
    expect(recoverStaleArchivingWorkspaces).toHaveBeenCalledWith(harness.context.services);
    const runScriptRecoveryOrder = vi.mocked(runScriptStateMachine.recoverStaleStates).mock
      .invocationCallOrder[0];
    const archiveRecoveryOrder = vi.mocked(recoverStaleArchivingWorkspaces).mock
      .invocationCallOrder[0];
    const snapshotReconciliationOrder = vi.mocked(configureSnapshotReconciliation).mock
      .invocationCallOrder[0];
    expect(runScriptRecoveryOrder).toBeDefined();
    expect(archiveRecoveryOrder).toBeDefined();
    expect(snapshotReconciliationOrder).toBeDefined();
    expect(runScriptRecoveryOrder ?? 0).toBeLessThan(archiveRecoveryOrder ?? 0);
    expect(archiveRecoveryOrder ?? 0).toBeLessThan(snapshotReconciliationOrder ?? 0);
    expect(startInterceptors).toHaveBeenCalledOnce();
    expect(reconciliationService.startPeriodicCleanup).toHaveBeenCalledOnce();
    expect(harness.services.rateLimiter.start).toHaveBeenCalledOnce();
    expect(harness.services.schedulerService.start).toHaveBeenCalledOnce();
    expect(harness.services.ratchetService.start).toHaveBeenCalledOnce();
  });

  it('rejects concurrent start calls without running startup cleanup', async () => {
    const harness = createTestHarness();
    let reconciliationStarted!: () => void;
    let continueReconciliation!: () => void;
    const reconciliationStartedPromise = new Promise<void>((resolve) => {
      reconciliationStarted = resolve;
    });
    const continueReconciliationPromise = new Promise<void>((resolve) => {
      continueReconciliation = resolve;
    });
    vi.mocked(reconciliationService.cleanupOrphans).mockImplementationOnce(async () => {
      reconciliationStarted();
      await continueReconciliationPromise;
    });

    const server = createTestServer(harness.context, 0);
    const startPromise = server.start();
    await reconciliationStartedPromise;

    await expect(server.start()).rejects.toThrow('Server startup has already been initiated');
    expect(stopInterceptors).not.toHaveBeenCalled();
    expect(harness.services.sessionService.stopAllClients).not.toHaveBeenCalled();
    expect(harness.services.schedulerService.stop).not.toHaveBeenCalled();
    expect(prisma.$disconnect).not.toHaveBeenCalled();

    continueReconciliation();
    await expect(startPromise).resolves.toBe('http://localhost:0');
    expect(server.getHttpServer().listening).toBe(true);
  });

  it('writes backend port to stdout when run script proxy mode is enabled', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const harness = createTestHarness({
      isRunScriptProxyEnabled: true,
    });
    const server = createTestServer(harness.context, 0);

    await server.start();

    expect(writeSpy).toHaveBeenCalledWith('BACKEND_PORT:0\n');
    writeSpy.mockRestore();
  });

  it('logs startup reconciliation failures and continues starting', async () => {
    const harness = createTestHarness();
    vi.mocked(reconciliationService.cleanupOrphans).mockRejectedValueOnce(
      new Error('cleanup failed')
    );
    vi.mocked(harness.services.sessionService.recoverStaleSessionStates).mockRejectedValueOnce(
      new Error('session recovery failed')
    );
    vi.mocked(reconciliationService.reconcile).mockRejectedValueOnce(new Error('reconcile failed'));
    vi.mocked(runScriptStateMachine.recoverStaleStates).mockRejectedValueOnce(
      new Error('run script recovery failed')
    );
    vi.mocked(recoverStaleArchivingWorkspaces).mockRejectedValueOnce(
      new Error('archive recovery failed')
    );

    const server = createTestServer(harness.context, 0);

    await expect(server.start()).resolves.toBe('http://localhost:0');
    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to cleanup orphan sessions on startup',
      expect.any(Object)
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to recover stale agent sessions on startup',
      expect.any(Object)
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to reconcile workspaces on startup',
      expect.any(Object)
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to recover stale run script states on startup',
      expect.any(Object)
    );
    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to recover stale archiving workspaces on startup',
      expect.any(Object)
    );
  });

  it('gates HTTP requests and websocket upgrades while startup reconciliation is pending', async () => {
    const harness = createTestHarness();
    let reconciliationStarted!: () => void;
    let continueReconciliation!: () => void;
    const reconciliationStartedPromise = new Promise<void>((resolve) => {
      reconciliationStarted = resolve;
    });
    const continueReconciliationPromise = new Promise<void>((resolve) => {
      continueReconciliation = resolve;
    });
    vi.mocked(reconciliationService.cleanupOrphans).mockImplementationOnce(async () => {
      reconciliationStarted();
      await continueReconciliationPromise;
    });

    const server = createTestServer(harness.context, 0);
    const startPromise = server.start();
    await reconciliationStartedPromise;
    await waitForHttpServerToListen(server);

    const response = await request(server.getHttpServer()).get('/health');
    const socket = {
      destroy: vi.fn(),
      write: vi.fn(),
    };
    const upgradeRequest = {
      headers: { host: 'localhost:3001' },
      url: '/chat?sessionId=s1',
    };
    server.getHttpServer().emit('upgrade', upgradeRequest, socket, Buffer.alloc(0));

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'Service starting' });
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('503 Service Unavailable'));
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(handlers.chat).not.toHaveBeenCalled();

    continueReconciliation();
    await expect(startPromise).resolves.toBe('http://localhost:0');

    const readyResponse = await request(server.getHttpServer()).get('/health');
    expect(readyResponse.status).toBe(200);
  });

  it('retries the next port when the requested port is already bound', async () => {
    const { startPort, servers: occupiedServers } = await occupyConsecutivePorts(2);
    const requestedPortReservation = occupiedServers[0];
    const nextPortReservation = occupiedServers[1];
    if (!(requestedPortReservation && nextPortReservation)) {
      throw new Error('Expected two occupied TCP port reservations');
    }

    await closeNetServer(nextPortReservation);

    try {
      const harness = createTestHarness({ backendHost: '127.0.0.1' });
      const server = createTestServer(harness.context, startPort);

      await expect(server.start()).resolves.toBe(`http://127.0.0.1:${startPort + 1}`);

      expect(server.getPort()).toBe(startPort + 1);
      expect(harness.services.findAvailablePort).not.toHaveBeenCalled();
      expect(harness.logger.warn).toHaveBeenCalledWith('Requested port in use, using alternative', {
        requestedPort: startPort,
        actualPort: startPort + 1,
      });
      expect(reconciliationService.cleanupOrphans).toHaveBeenCalledOnce();
      expect(startInterceptors).toHaveBeenCalledOnce();
    } finally {
      await closeNetServer(requestedPortReservation);
    }
  });

  it('rejects startup after all bind fallback ports are already bound', async () => {
    const { startPort, servers: occupiedServers } = await occupyConsecutivePorts(10);

    try {
      const harness = createTestHarness({ backendHost: '127.0.0.1' });
      const server = createTestServer(harness.context, startPort);

      await expect(server.start()).rejects.toThrow(
        `Could not bind server to an available port starting from ${startPort}`
      );

      expect(harness.services.findAvailablePort).not.toHaveBeenCalled();
      expect(configureSnapshotReconciliation).not.toHaveBeenCalled();
      expect(startInterceptors).not.toHaveBeenCalled();
    } finally {
      await Promise.all(occupiedServers.map(closeNetServer));
    }
  });

  it('rejects start when http server emits an error', async () => {
    const harness = createTestHarness();
    const server = createTestServer(harness.context, 0);
    const httpServer = server.getHttpServer();

    vi.spyOn(httpServer, 'listen').mockImplementation(() => httpServer);

    const startPromise = server.start();
    await Promise.resolve();
    httpServer.emit('error', new Error('listen failed'));

    await expect(startPromise).rejects.toThrow('listen failed');
    expect(configureSnapshotReconciliation).not.toHaveBeenCalled();
  });

  it('runs normal cleanup when startup fails after the server is bound', async () => {
    const harness = createTestHarness();
    vi.mocked(harness.services.schedulerService.start).mockImplementationOnce(() => {
      throw new Error('scheduler failed');
    });
    const server = createTestServer(harness.context, 0);

    await expect(server.start()).rejects.toThrow('scheduler failed');

    expect(server.getHttpServer().listening).toBe(false);
    expect(stopInterceptors).toHaveBeenCalledOnce();
    expect(harness.services.sessionService.stopAllClients).toHaveBeenCalledWith(5000);
    expect(harness.services.terminalService.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.sessionFileLogger.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.acpTraceLogger.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.rateLimiter.stop).toHaveBeenCalledOnce();
    expect(harness.services.schedulerService.stop).toHaveBeenCalledOnce();
    expect(stopEventCollector).toHaveBeenCalledOnce();
    expect(snapshotReconciliationService.stop).toHaveBeenCalledOnce();
    expect(workspaceGitStateService.stop).toHaveBeenCalledOnce();
    expect(
      vi.mocked(snapshotReconciliationService.stop).mock.invocationCallOrder[0] ?? 0
    ).toBeLessThan(vi.mocked(workspaceGitStateService.stop).mock.invocationCallOrder[0] ?? 0);
    expect(harness.services.ratchetService.stop).toHaveBeenCalledOnce();
    expect(reconciliationService.stopPeriodicCleanup).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it('does not allow retrying start after startup failure cleanup', async () => {
    const harness = createTestHarness();
    vi.mocked(harness.services.schedulerService.start).mockImplementationOnce(() => {
      throw new Error('scheduler failed');
    });
    const server = createTestServer(harness.context, 0);

    await expect(server.start()).rejects.toThrow('scheduler failed');

    expect(server.getHttpServer().listening).toBe(false);
    await expect(server.start()).rejects.toThrow('Server has already been stopped');

    await server.stop();
    expect(stopInterceptors).toHaveBeenCalledOnce();
    expect(harness.services.sessionService.stopAllClients).toHaveBeenCalledOnce();
    expect(harness.services.schedulerService.stop).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
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
    expect(workspaceGitStateService.stop).toHaveBeenCalledOnce();
    expect(harness.services.ratchetService.stop).toHaveBeenCalledOnce();
    expect(reconciliationService.stopPeriodicCleanup).toHaveBeenCalledOnce();
    expect(prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it('serves static index fallback with no-cache headers and bypasses API routes', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: true });
    const harness = createTestHarness({ frontendStaticPath });
    const server = createTestServer(harness.context);

    const fallbackResponse = await request(server.getHttpServer()).get('/workspace/abc');
    const deepFallbackResponse = await request(server.getHttpServer()).get(
      '/workspace/abc/session/def'
    );
    const apiResponse = await request(server.getHttpServer()).get('/api/unknown');

    expect(fallbackResponse.status).toBe(200);
    expect(fallbackResponse.text).toContain('factory-factory');
    expect(fallbackResponse.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(fallbackResponse.headers.pragma).toBe('no-cache');
    expect(fallbackResponse.headers.expires).toBe('0');
    expect(deepFallbackResponse.status).toBe(200);
    expect(deepFallbackResponse.text).toContain('factory-factory');
    expect(deepFallbackResponse.headers['cache-control']).toBe(
      'no-cache, no-store, must-revalidate'
    );
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
