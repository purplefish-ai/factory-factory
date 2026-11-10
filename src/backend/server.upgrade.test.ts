import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { deferred } from '@/test-utils/deferred';

const { handlers, handlerFactories, transportDisposers } = vi.hoisted(() => {
  const upgradeHandlers = {
    chat: vi.fn(),
    terminal: vi.fn(),
    setupTerminal: vi.fn(),
    devLogs: vi.fn(),
    postRunLogs: vi.fn(),
    snapshots: vi.fn(),
    voice: vi.fn(),
  };

  return {
    handlers: upgradeHandlers,
    handlerFactories: {
      chat: vi.fn(() => upgradeHandlers.chat),
      terminal: vi.fn(() => upgradeHandlers.terminal),
      setupTerminal: vi.fn(() => upgradeHandlers.setupTerminal),
      devLogs: vi.fn(() => upgradeHandlers.devLogs),
      postRunLogs: vi.fn(() => upgradeHandlers.postRunLogs),
      snapshots: vi.fn(() => upgradeHandlers.snapshots),
      voice: vi.fn(() => upgradeHandlers.voice),
    },
    transportDisposers: {
      chat: vi.fn(),
      snapshots: vi.fn(),
    },
  };
});

vi.mock('@/backend/routers/websocket', () => ({
  createChatUpgradeHandler: handlerFactories.chat,
  createTerminalUpgradeHandler: handlerFactories.terminal,
  createSetupTerminalUpgradeHandler: handlerFactories.setupTerminal,
  createDevLogsUpgradeHandler: handlerFactories.devLogs,
  createPostRunLogsUpgradeHandler: handlerFactories.postRunLogs,
  createSnapshotsUpgradeHandler: handlerFactories.snapshots,
  createVoiceUpgradeHandler: handlerFactories.voice,
  disposeChatTransportForApplication: transportDisposers.chat,
  disposeSnapshotsHandlerState: transportDisposers.snapshots,
}));

vi.mock('@/backend/trpc/index', () => ({
  appRouter: {},
  createContext: vi.fn(() => () => ({})),
}));

vi.mock('@trpc/server/adapters/express', () => ({
  createExpressMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createServer } from './server';
import { createTestApplication, createTestHarness } from './server.test-helpers';

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

  const createTestServer = (application = createTestApplication(), requestedPort?: number) => {
    const server = createServer(application, requestedPort);
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

  it('supplies the exact application graph to every upgrade handler factory', () => {
    const application = createTestApplication();

    createTestServer(application);

    expect(handlerFactories.chat).toHaveBeenCalledWith(application);
    expect(handlerFactories.terminal).toHaveBeenCalledWith(application);
    expect(handlerFactories.setupTerminal).toHaveBeenCalledWith(application);
    expect(handlerFactories.devLogs).toHaveBeenCalledWith(application);
    expect(handlerFactories.postRunLogs).toHaveBeenCalledWith(application);
    expect(handlerFactories.snapshots).toHaveBeenCalledWith(application);
    expect(handlerFactories.voice).toHaveBeenCalledWith(application);
  });

  it('routes /voice upgrades to voice handler', () => {
    const server = createTestServer();

    const request = {
      headers: { host: 'localhost:3001' },
      url: '/voice?sessionId=s1',
    };
    const socket = { destroy: vi.fn() };

    server.getHttpServer().emit('upgrade', request, socket, Buffer.alloc(0));

    expect(handlers.voice).toHaveBeenCalledOnce();
    expect(handlers.chat).not.toHaveBeenCalled();
    expect(handlers.terminal).not.toHaveBeenCalled();
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

  it('starts an already-composed application without rewiring dependencies', async () => {
    const { application, lifecycle } = createTestHarness();
    const server = createTestServer(application, 0);

    const endpoint = await server.start();

    expect(endpoint).toBe('http://localhost:0');
    expect(server.getPort()).toBe(0);
    expect(lifecycle.wireDomainBridges).not.toHaveBeenCalled();
    expect(lifecycle.eventCollector.configure).not.toHaveBeenCalled();
    expect(lifecycle.snapshotReconciliation.configure).not.toHaveBeenCalled();
    expect(lifecycle.snapshotReconciliation.start).toHaveBeenCalledOnce();
    expect(application.services.agentRuntime.start).toHaveBeenCalledOnce();
  });

  it.each([false, true])('rejects interrupted startup (shutdown=%s)', async (stopDuringStartup) => {
    const harness = createTestHarness();
    const reconciliationStarted = deferred();
    const continueReconciliation = deferred();
    vi.mocked(harness.services.runScriptStateMachine.recoverStaleStates).mockImplementationOnce(
      async () => {
        reconciliationStarted.resolve();
        await continueReconciliation.promise;
      }
    );

    const server = createTestServer(harness.application, 0);
    const startPromise = server.start();
    await reconciliationStarted.promise;

    await expect(server.start()).rejects.toThrow('Server startup has already been initiated');
    expect(harness.lifecycle.interceptors.stop).not.toHaveBeenCalled();
    expect(harness.services.sessionLifecycleService.stopAllClients).not.toHaveBeenCalled();
    expect(harness.services.schedulerService.stop).not.toHaveBeenCalled();
    expect(harness.lifecycle.database.$disconnect).not.toHaveBeenCalled();

    if (stopDuringStartup) {
      await server.stop();
      expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
      continueReconciliation.resolve();
      await expect(startPromise).rejects.toThrow('Server startup interrupted by shutdown');
      expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
      expect(harness.lifecycle.recoverStaleArchivingWorkspaces).not.toHaveBeenCalled();
      expect(harness.lifecycle.snapshotReconciliation.start).not.toHaveBeenCalled();
      expect(harness.services.agentRuntime.start).not.toHaveBeenCalled();
      expect(server.getHttpServer().listening).toBe(false);
      return;
    }
    continueReconciliation.resolve();
    await expect(startPromise).resolves.toBe('http://localhost:0');
    expect(server.getHttpServer().listening).toBe(true);
  });

  it('writes backend port to stdout when run script proxy mode is enabled', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const harness = createTestHarness({
      isRunScriptProxyEnabled: true,
    });
    const server = createTestServer(harness.application, 0);

    await server.start();

    expect(writeSpy).toHaveBeenCalledWith('BACKEND_PORT:0\n');
    writeSpy.mockRestore();
  });

  it('logs startup reconciliation failures and continues starting', async () => {
    const harness = createTestHarness();
    const reconciliation = harness.services.reconciliationService;
    vi.mocked(reconciliation.cleanupOrphans).mockRejectedValueOnce(new Error('cleanup failed'));
    vi.mocked(
      harness.services.sessionLifecycleService.recoverStaleRunningSessions
    ).mockRejectedValueOnce(new Error('session recovery failed'));
    vi.mocked(reconciliation.recoverStaleProvisioningWorkspaces).mockRejectedValueOnce(
      new Error('reconcile failed')
    );
    vi.mocked(harness.services.runScriptStateMachine.recoverStaleStates).mockRejectedValueOnce(
      new Error('run script recovery failed')
    );
    vi.mocked(harness.lifecycle.recoverStaleArchivingWorkspaces).mockRejectedValueOnce(
      new Error('archive recovery failed')
    );

    const server = createTestServer(harness.application, 0);

    await expect(server.start()).resolves.toBe('http://localhost:0');
    expect(reconciliation.startNewWorkspaceInitialization).toHaveBeenCalledOnce();
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

  it('recovers stale agent session states through the lifecycle service at startup', async () => {
    const harness = createTestHarness();
    vi.mocked(
      harness.services.sessionLifecycleService.recoverStaleRunningSessions
    ).mockResolvedValueOnce(3);
    const server = createTestServer(harness.application, 0);

    await expect(server.start()).resolves.toBe('http://localhost:0');

    expect(
      harness.services.sessionLifecycleService.recoverStaleRunningSessions
    ).toHaveBeenCalledOnce();
    expect(harness.logger.info).toHaveBeenCalledWith(
      'Recovered stale agent session states on startup',
      { recoveredCount: 3 }
    );
  });

  it('serves requests and signals readiness while archive recovery is pending', async () => {
    const harness = createTestHarness({ isRunScriptProxyEnabled: true });
    const { promise: recovery, resolve: finishRecovery } = deferred();
    harness.lifecycle.recoverStaleArchivingWorkspaces.mockImplementationOnce(async () => {
      await recovery;
      return { archived: [], failed: [] };
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const server = createTestServer(harness.application, 0);
    try {
      const started = server.start();
      await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledWith('BACKEND_PORT:0\n'));
      await started;
      expect((await request(server.getHttpServer()).get('/health')).status).toBe(200);

      const socket = { destroy: vi.fn(), write: vi.fn() };
      server
        .getHttpServer()
        .emit(
          'upgrade',
          { headers: { host: 'localhost:3001' }, url: '/chat?sessionId=s1' },
          socket,
          Buffer.alloc(0)
        );
      expect(handlers.chat).toHaveBeenCalledOnce();
      expect(socket.destroy).not.toHaveBeenCalled();
    } finally {
      finishRecovery();
      writeSpy.mockRestore();
    }
  });

  it('drains archive recovery before shutting down its dependencies', async () => {
    const harness = createTestHarness();
    const { promise: recovery, resolve: finishRecovery } = deferred();
    harness.lifecycle.recoverStaleArchivingWorkspaces.mockImplementationOnce(async () => {
      await recovery;
      return { archived: [], failed: [] };
    });
    const server = createTestServer(harness.application, 0);
    try {
      let ready = false;
      const started = server.start().then(() => {
        ready = true;
      });
      await vi.waitFor(() => expect(ready).toBe(true));
      await started;

      const stopped = server.stop();
      await vi.waitFor(() => expect(harness.services.agentRuntime.stop).toHaveBeenCalledOnce());
      expect(harness.services.sessionLifecycleService.stopAllClients).not.toHaveBeenCalled();
      expect(harness.services.runScriptService.cleanup).not.toHaveBeenCalled();
      expect(harness.lifecycle.database.$disconnect).not.toHaveBeenCalled();

      finishRecovery();
      await stopped;
      expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
    } finally {
      finishRecovery();
    }
  });

  it('gates HTTP requests and websocket upgrades while startup reconciliation is pending', async () => {
    const harness = createTestHarness();
    const reconciliationStarted = deferred();
    const continueReconciliation = deferred();
    vi.mocked(harness.services.reconciliationService.cleanupOrphans).mockImplementationOnce(
      async () => {
        reconciliationStarted.resolve();
        await continueReconciliation.promise;
      }
    );

    const server = createTestServer(harness.application, 0);
    const startPromise = server.start();
    await reconciliationStarted.promise;
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

    continueReconciliation.resolve();
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
      const server = createTestServer(harness.application, startPort);

      await expect(server.start()).resolves.toBe(`http://127.0.0.1:${startPort + 1}`);

      expect(server.getPort()).toBe(startPort + 1);
      expect(harness.services.findAvailablePort).not.toHaveBeenCalled();
      expect(harness.logger.warn).toHaveBeenCalledWith('Requested port in use, using alternative', {
        requestedPort: startPort,
        actualPort: startPort + 1,
      });
      expect(harness.services.reconciliationService.cleanupOrphans).toHaveBeenCalledOnce();
      expect(harness.lifecycle.interceptors.start).toHaveBeenCalledOnce();
    } finally {
      await closeNetServer(requestedPortReservation);
    }
  });

  it('rejects startup after all bind fallback ports are already bound', async () => {
    const { startPort, servers: occupiedServers } = await occupyConsecutivePorts(10);

    try {
      const harness = createTestHarness({ backendHost: '127.0.0.1' });
      const server = createTestServer(harness.application, startPort);

      await expect(server.start()).rejects.toThrow(
        `Could not bind server to an available port starting from ${startPort}`
      );

      expect(harness.services.findAvailablePort).not.toHaveBeenCalled();
      expect(harness.lifecycle.snapshotReconciliation.start).not.toHaveBeenCalled();
      expect(harness.lifecycle.interceptors.start).not.toHaveBeenCalled();
    } finally {
      await Promise.all(occupiedServers.map(closeNetServer));
    }
  });

  it('does not try to bind ports above the valid TCP range', async () => {
    const harness = createTestHarness({ backendHost: '127.0.0.1' });
    const server = createTestServer(harness.application, 65_535);
    const httpServer = server.getHttpServer();
    const addressInUseError = Object.assign(new Error('address in use'), {
      code: 'EADDRINUSE',
    });
    const listenSpy = vi
      .spyOn(httpServer, 'listen')
      .mockImplementationOnce(() => {
        queueMicrotask(() => httpServer.emit('error', addressInUseError));
        return httpServer;
      })
      .mockImplementation(() => {
        throw Object.assign(new RangeError('bad port'), {
          code: 'ERR_SOCKET_BAD_PORT',
        });
      });

    try {
      await expect(server.start()).rejects.toThrow(
        'Could not bind server to an available port starting from 65535'
      );
      expect(listenSpy).toHaveBeenCalledOnce();
      expect(listenSpy).toHaveBeenCalledWith(65_535, '127.0.0.1');
    } finally {
      listenSpy.mockRestore();
    }
  });

  it('rejects start when http server emits an error', async () => {
    const harness = createTestHarness();
    const server = createTestServer(harness.application, 0);
    const httpServer = server.getHttpServer();

    vi.spyOn(httpServer, 'listen').mockImplementation(() => httpServer);

    const startPromise = server.start();
    await Promise.resolve();
    httpServer.emit('error', new Error('listen failed'));

    await expect(startPromise).rejects.toThrow('listen failed');
    expect(harness.lifecycle.snapshotReconciliation.start).not.toHaveBeenCalled();
  });

  it('runs normal cleanup when startup fails after the server is bound', async () => {
    const harness = createTestHarness();
    vi.mocked(harness.services.schedulerService.start).mockImplementationOnce(() => {
      throw new Error('scheduler failed');
    });
    const server = createTestServer(harness.application, 0);

    await expect(server.start()).rejects.toThrow('scheduler failed');

    expect(server.getHttpServer().listening).toBe(false);
    expect(harness.lifecycle.interceptors.stop).toHaveBeenCalledOnce();
    expect(harness.services.sessionLifecycleService.stopAllClients).toHaveBeenCalledWith(5000);
    expect(harness.services.terminalService.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.sessionFileLogger.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.acpTraceLogger.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.rateLimiter.stop).toHaveBeenCalledOnce();
    expect(harness.services.schedulerService.stop).toHaveBeenCalledOnce();
    expect(harness.services.periodicTaskService.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.eventCollector.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.snapshotReconciliation.stop).toHaveBeenCalledOnce();
    expect(harness.services.workspaceGitStateService.stop).toHaveBeenCalledOnce();
    expect(
      harness.lifecycle.snapshotReconciliation.stop.mock.invocationCallOrder[0] ?? 0
    ).toBeLessThan(harness.services.workspaceGitStateService.stop.mock.invocationCallOrder[0] ?? 0);
    expect(harness.services.ratchetService.stop).toHaveBeenCalledOnce();
    expect(harness.services.reconciliationService.stopPeriodicCleanup).toHaveBeenCalledOnce();
    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('does not allow retrying start after startup failure cleanup', async () => {
    const harness = createTestHarness();
    vi.mocked(harness.services.schedulerService.start).mockImplementationOnce(() => {
      throw new Error('scheduler failed');
    });
    const server = createTestServer(harness.application, 0);

    await expect(server.start()).rejects.toThrow('scheduler failed');

    expect(server.getHttpServer().listening).toBe(false);
    await expect(server.start()).rejects.toThrow('Server has already been stopped');

    await server.stop();
    expect(harness.lifecycle.interceptors.stop).toHaveBeenCalledOnce();
    expect(harness.services.sessionLifecycleService.stopAllClients).toHaveBeenCalledOnce();
    expect(harness.services.schedulerService.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('runs cleanup fan-out when server stops', async () => {
    const harness = createTestHarness();
    const server = createTestServer(harness.application);

    await server.stop();

    expect(harness.lifecycle.interceptors.stop).toHaveBeenCalledOnce();
    expect(harness.services.agentRuntime.stop).toHaveBeenCalledOnce();
    expect(harness.services.agentRuntime.stop.mock.invocationCallOrder[0]).toBeLessThan(
      harness.services.sessionLifecycleService.stopAllClients.mock.invocationCallOrder[0] ?? 0
    );
    expect(harness.services.sessionLifecycleService.stopAllClients).toHaveBeenCalledWith(5000);
    expect(harness.services.terminalService.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.sessionFileLogger.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.acpTraceLogger.cleanup).toHaveBeenCalledOnce();
    expect(harness.services.rateLimiter.stop).toHaveBeenCalledOnce();
    expect(harness.services.schedulerService.stop).toHaveBeenCalledOnce();
    expect(harness.services.periodicTaskService.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.eventCollector.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.snapshotReconciliation.stop).toHaveBeenCalledOnce();
    expect(harness.services.workspaceGitStateService.stop).toHaveBeenCalledOnce();
    expect(harness.services.ratchetService.stop).toHaveBeenCalledOnce();
    expect(harness.services.reconciliationService.stopPeriodicCleanup).toHaveBeenCalledOnce();
    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
    expect(transportDisposers.chat).toHaveBeenCalledWith(harness.application);
    expect(transportDisposers.snapshots).toHaveBeenCalledWith(harness.application);
  });

  it('waits for run-script cleanup before disconnecting the database', async () => {
    const harness = createTestHarness();
    let finishRunScriptCleanup!: () => void;
    const runScriptCleanupCanFinish = new Promise<void>((resolve) => {
      finishRunScriptCleanup = resolve;
    });
    vi.mocked(harness.services.runScriptService.cleanup).mockReturnValueOnce(
      runScriptCleanupCanFinish
    );
    const server = createTestServer(harness.application);

    const stopPromise = server.stop();

    await vi.waitFor(() => {
      expect(harness.services.runScriptService.cleanup).toHaveBeenCalledOnce();
    });
    expect(harness.lifecycle.database.$disconnect).not.toHaveBeenCalled();

    finishRunScriptCleanup();
    await stopPromise;

    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('does not start interceptors when shutdown begins during stale share recovery', async () => {
    const { application, lifecycle, services } = createTestHarness();
    const server = createTestServer(application, 0);
    vi.mocked(services.portShareService.stopStaleShares).mockImplementationOnce(async () => {
      await server.stop();
    });

    await expect(server.start()).rejects.toThrow('Server startup interrupted by shutdown');
    expect(lifecycle.interceptors.start).not.toHaveBeenCalled();
    expect(services.ratchetService.start).not.toHaveBeenCalled();
  });

  it('stops reconciliation when shutdown begins but drains it before disconnecting', async () => {
    const { application, lifecycle, services } = createTestHarness();
    const { promise: drained, resolve: drain } = deferred<undefined>();
    vi.mocked(services.reconciliationService.stopPeriodicCleanup).mockReturnValueOnce(drained);
    const server = createTestServer(application, 0);
    vi.mocked(services.ratchetService.start).mockImplementationOnce(() => void server.stop());
    const starting = server.start();
    starting.catch(() => undefined);
    await vi.waitFor(() =>
      expect(services.sessionLifecycleService.stopAllClients).toHaveBeenCalledOnce()
    );
    expect(services.reconciliationService.stopPeriodicCleanup).toHaveBeenCalledOnce();
    expect(
      services.reconciliationService.stopPeriodicCleanup.mock.invocationCallOrder[0] ?? 0
    ).toBeLessThan(
      services.sessionLifecycleService.stopAllClients.mock.invocationCallOrder[0] ?? 0
    );
    expect(services.reconciliationService.startNewWorkspaceInitialization).not.toHaveBeenCalled();
    // Cleanup has already stopped these; starting them now would revive them.
    expect(services.periodicTaskService.start).not.toHaveBeenCalled();
    expect(services.agentRuntime.start).not.toHaveBeenCalled();
    expect(lifecycle.database.$disconnect).not.toHaveBeenCalled();
    drain(undefined);
    await expect(starting).rejects.toThrow('Server startup interrupted by shutdown');
    expect(lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('closes active WebSocket clients before completing server cleanup', async () => {
    handlers.chat.mockImplementationOnce((request, socket, head, _url, wss) => {
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        wss.emit('connection', ws, request);
      });
    });
    const harness = createTestHarness({ backendHost: '127.0.0.1' });
    const server = createTestServer(harness.application, 0);
    await server.start();
    const address = server.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the server to listen on a TCP port');
    }

    const client = new WebSocket(`ws://127.0.0.1:${address.port}/chat`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));

    await server.stop();
    await closed;

    expect(client.readyState).toBe(WebSocket.CLOSED);
  });

  it('starts and idempotently stops only the supplied application graph', async () => {
    const harness = createTestHarness();
    const server = createTestServer(harness.application, 0);

    await server.start();
    await Promise.all([server.stop(), server.stop()]);

    expect(harness.lifecycle.interceptors.start).toHaveBeenCalledOnce();
    expect(harness.lifecycle.interceptors.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.eventCollector.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.snapshotReconciliation.start).toHaveBeenCalledOnce();
    expect(harness.lifecycle.snapshotReconciliation.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('serves static index fallback with no-cache headers and bypasses API routes', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: true });
    const harness = createTestHarness({ frontendStaticPath });
    const server = createTestServer(harness.application);

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

  it('routes /proxy links to port sharing instead of the SPA fallback', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: true });
    const server = createTestServer(createTestApplication({ frontendStaticPath }));

    const response = await request(server.getHttpServer()).get('/proxy/6173/?path=/story/x').set({
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    });

    expect(response.status).toBe(404);
    expect(response.text).toContain('Port sharing is off');
    expect(response.text).not.toContain('factory-factory');
  });

  it('sets no-cache headers when index.html is requested directly', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: true });
    const server = createTestServer(createTestApplication({ frontendStaticPath }));

    const response = await request(server.getHttpServer()).get('/index.html');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.headers.expires).toBe('0');
  });

  it('serves build-time Brotli siblings for assets and the SPA fallback', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: true });
    for (const file of ['assets/app.js', 'index.html']) {
      writeFileSync(
        join(frontendStaticPath, `${file}.br`),
        brotliCompressSync(`compressed ${file}`)
      );
    }
    const server = createTestServer(createTestApplication({ frontendStaticPath }));
    const get = (path: string) =>
      request(server.getHttpServer()).get(path).set('Accept-Encoding', 'gzip, deflate, br');

    const asset = await get('/assets/app.js');
    const fallback = await get('/workspace/abc');

    expect(asset.headers['content-encoding']).toBe('br');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.vary).toBe('Accept-Encoding');
    expect(asset.text).toBe('compressed assets/app.js');
    expect(fallback.headers['content-encoding']).toBe('br');
    expect(fallback.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(fallback.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(fallback.text).toBe('compressed index.html');
  });

  it('returns 503 when static fallback index.html is missing', async () => {
    const frontendStaticPath = createStaticFrontendDir({ withIndex: false });
    const harness = createTestHarness({ frontendStaticPath });
    const server = createTestServer(harness.application);

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
