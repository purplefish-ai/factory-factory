/**
 * Backend Server Module
 *
 * Exports server creation and lifecycle functions for use by:
 * - CLI/standalone mode (index.ts)
 * - Electron main process (server-manager.ts)
 *
 * Configuration is passed via environment variables which must be set
 * BEFORE importing this module:
 * - DATABASE_PATH: SQLite database file path
 * - FRONTEND_STATIC_PATH: Path to frontend build (optional)
 * - BACKEND_PORT: Server port (default: 3001)
 * - NODE_ENV: Environment (development/production)
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { WebSocketServer } from 'ws';
import { type AppContext, createAppContext } from './app-context';
import { prisma } from './db';
import { registerInterceptors, startInterceptors, stopInterceptors } from './interceptors';
import { toError } from './lib/error-utils';
import {
  createCorsMiddleware,
  createRequestLoggerMiddleware,
  securityMiddleware,
} from './middleware';
import { configureDomainBridges } from './orchestration/domain-bridges.orchestrator';
import {
  configureEventCollector,
  stopEventCollector,
} from './orchestration/event-collector.orchestrator';
import {
  configureSnapshotReconciliation,
  snapshotReconciliationService,
} from './orchestration/snapshot-reconciliation.orchestrator';
import { recoverStaleArchivingWorkspaces } from './orchestration/workspace-archive.orchestrator';
import { createHealthRouter } from './routers/health.router';
import {
  createChatUpgradeHandler,
  createDevLogsUpgradeHandler,
  createPostRunLogsUpgradeHandler,
  createSetupTerminalUpgradeHandler,
  createSnapshotsUpgradeHandler,
  createTerminalUpgradeHandler,
} from './routers/websocket';
import { periodicTaskService } from './services/periodic-task';
import { reconciliationService } from './services/ratchet';
import { runScriptStateMachine } from './services/run-script';
import { workspaceAccessor } from './services/workspace';
import { appRouter, createContext } from './trpc/index';
import type { ServerInstance } from './types/server-instance';

export type { ServerInstance };

/**
 * Create and configure the backend server.
 * Environment variables must be set before calling this function.
 *
 * @param requestedPort - Port to listen on (default: from BACKEND_PORT env or 3001)
 * @returns ServerInstance with start/stop methods
 */
export function createServer(requestedPort?: number, appContext?: AppContext): ServerInstance {
  const context = appContext ?? createAppContext();
  const {
    acpTraceLogger,
    configService,
    createLogger,
    ratchetService,
    rateLimiter,
    schedulerService,
    sessionFileLogger,
    sessionService,
    terminalService,
  } = context.services;

  const logger = createLogger('server');
  const REQUESTED_PORT = requestedPort ?? configService.getBackendPort();
  const REQUESTED_HOST = configService.getBackendHost();
  const ENDPOINT_HOST = REQUESTED_HOST ?? 'localhost';
  const PORT_BIND_MAX_ATTEMPTS = 10;
  let actualPort: number = REQUESTED_PORT;
  let explicitStartupStarted = false;
  let startupComplete = false;
  let cleanupStarted = false;
  let cleanupPromise: Promise<void> | null = null;

  const app = express();

  // Create HTTP server and WebSocket server
  const server = createHttpServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const chatUpgradeHandler = createChatUpgradeHandler(context);
  const terminalUpgradeHandler = createTerminalUpgradeHandler(context);
  const setupTerminalUpgradeHandler = createSetupTerminalUpgradeHandler(context);
  const devLogsUpgradeHandler = createDevLogsUpgradeHandler(context);
  const postRunLogsUpgradeHandler = createPostRunLogsUpgradeHandler(context);
  const snapshotsUpgradeHandler = createSnapshotsUpgradeHandler(context);
  const websocketUpgradeHandlers = new Map<string, typeof chatUpgradeHandler>([
    ['/chat', chatUpgradeHandler],
    ['/terminal', terminalUpgradeHandler],
    ['/setup-terminal', setupTerminalUpgradeHandler],
    ['/dev-logs', devLogsUpgradeHandler],
    ['/post-run-logs', postRunLogsUpgradeHandler],
    ['/snapshots', snapshotsUpgradeHandler],
  ]);

  const isAddressInUseError = (error: unknown): error is NodeJS.ErrnoException =>
    error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';

  const listenOnPort = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);

      try {
        server.listen(port, REQUESTED_HOST);
      } catch (error) {
        server.off('error', onError);
        server.off('listening', onListening);
        reject(error);
      }
    });

  const bindServerWithPortFallback = async (): Promise<void> => {
    let lastAddressInUseError: NodeJS.ErrnoException | undefined;

    for (let attempt = 0; attempt < PORT_BIND_MAX_ATTEMPTS; attempt++) {
      const candidatePort = REQUESTED_PORT + attempt;

      try {
        await listenOnPort(candidatePort);
        actualPort = candidatePort;

        if (actualPort !== REQUESTED_PORT) {
          logger.warn('Requested port in use, using alternative', {
            requestedPort: REQUESTED_PORT,
            actualPort,
          });
        }

        return;
      } catch (error) {
        if (!isAddressInUseError(error)) {
          throw error;
        }

        lastAddressInUseError = error;
      }
    }

    const error = new Error(
      `Could not bind server to an available port starting from ${REQUESTED_PORT}`
    );
    error.cause = lastAddressInUseError;
    throw error;
  };

  const closeBoundServer = async (): Promise<void> => {
    if (!server.listening) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  // ============================================================================
  // WebSocket Heartbeat - Detect zombie connections
  // ============================================================================
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const wsAliveMap = new WeakMap<import('ws').WebSocket, boolean>();

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (wsAliveMap.get(ws) === false) {
        logger.info('Terminating unresponsive WebSocket connection');
        ws.terminate();
        return;
      }
      wsAliveMap.set(ws, false);
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  // ============================================================================
  // Middleware
  // ============================================================================
  app.use(securityMiddleware);
  app.use(createCorsMiddleware(context));
  app.use(createRequestLoggerMiddleware(context));
  app.use(express.json({ limit: '10mb' }));
  app.use((_req, res, next) => {
    if (!explicitStartupStarted || startupComplete) {
      next();
      return;
    }

    res.set('Retry-After', '1');
    res.status(503).json({
      error: 'Service starting',
      message: 'Backend startup is still completing. Please retry shortly.',
    });
  });

  // ============================================================================
  // Initialize Interceptors
  // ============================================================================
  registerInterceptors();

  // ============================================================================
  // Mount HTTP Routes
  // ============================================================================
  app.use('/health', createHealthRouter(context));
  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext: createContext(context),
    })
  );

  // ============================================================================
  // Static File Serving (Production Mode)
  // ============================================================================
  const frontendStaticPath = configService.getFrontendStaticPath();
  let indexHtmlReloadInterval: NodeJS.Timeout | null = null;
  if (frontendStaticPath && existsSync(frontendStaticPath)) {
    logger.info('Serving static files from', { path: frontendStaticPath });
    const indexHtmlPath = join(frontendStaticPath, 'index.html');
    let indexHtml: string | null = null;
    const loadStaticIndexHtml = (message: string) => {
      try {
        indexHtml = readFileSync(indexHtmlPath, 'utf8');
        if (indexHtmlReloadInterval !== null) {
          clearInterval(indexHtmlReloadInterval);
          indexHtmlReloadInterval = null;
        }
      } catch (error) {
        logger.debug(message, {
          path: indexHtmlPath,
          error: toError(error).message,
        });
      }
    };
    loadStaticIndexHtml('Failed to load static index.html for SPA fallback');
    if (indexHtml === null) {
      indexHtmlReloadInterval = setInterval(() => {
        loadStaticIndexHtml('Failed to reload static index.html for SPA fallback');
      }, 5000);
      indexHtmlReloadInterval.unref?.();
    }

    // Serve hashed assets (JS, CSS in /assets/) with long cache - they have content hashes
    app.use(
      '/assets',
      express.static(join(frontendStaticPath, 'assets'), {
        maxAge: '1y',
        immutable: true,
        etag: false, // Not needed with immutable content-hashed files
      })
    );

    // Serve other static files (favicon, images, etc.) with moderate cache
    app.use(
      express.static(frontendStaticPath, {
        maxAge: '1d',
        etag: true,
        index: false, // Don't serve index.html from here - handle it separately below
        setHeaders: (res, filePath) => {
          // Override cache for index.html if accessed directly via /index.html
          if (filePath.endsWith('index.html')) {
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
          }
        },
      })
    );

    // SPA fallback - serve index.html with no-cache so browsers always get fresh version
    app.get('/{*splat}', (req, res, next) => {
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/health') ||
        req.path === '/chat' ||
        req.path === '/terminal' ||
        req.path === '/setup-terminal' ||
        req.path === '/dev-logs' ||
        req.path === '/post-run-logs' ||
        req.path === '/snapshots'
      ) {
        return next();
      }
      // Set no-cache headers for index.html so browsers always check for updates
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      if (indexHtml === null) {
        logger.debug('Failed to serve index.html for SPA fallback', {
          path: req.path,
          error: 'index.html was not loaded at startup',
        });
        res.status(503).send('Service temporarily unavailable. Please refresh the page.');
        return;
      }
      res.type('html').send(indexHtml);
    });
  }

  // ============================================================================
  // Error Handling
  // ============================================================================
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error('Unhandled error', err);
      res.status(500).json({
        error: 'Internal server error',
        message: configService.isDevelopment() ? err.message : 'An unexpected error occurred',
      });
    }
  );

  // ============================================================================
  // WebSocket Upgrade Handler
  // ============================================================================
  server.on('upgrade', (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url || '', `http://${request.headers.host}`);
    } catch {
      socket.destroy();
      return;
    }

    if (explicitStartupStarted && !startupComplete) {
      socket.write(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n'
      );
      socket.destroy();
      return;
    }

    const upgradeHandler = websocketUpgradeHandlers.get(url.pathname);
    if (upgradeHandler) {
      upgradeHandler(request, socket, head, url, wss, wsAliveMap);
      return;
    }

    socket.destroy();
  });

  // ============================================================================
  // Cleanup Logic
  // ============================================================================
  const SHUTDOWN_TIMEOUT_MS = 5000;

  const runStartupTask = async (errorMessage: string, task: () => Promise<void>): Promise<void> => {
    try {
      await task();
    } catch (error) {
      logger.error(errorMessage, toError(error));
    }
  };

  const recoverStaleArchivingOnStartup = async (): Promise<void> => {
    const recovered = await recoverStaleArchivingWorkspaces(context.services);
    if (recovered.archived.length > 0 || recovered.failed.length > 0) {
      logger.info('Recovered stale archiving workspaces on startup', {
        archived: recovered.archived,
        failed: recovered.failed,
      });
    }
  };

  const recoverStaleAutoIterationOnStartup = async (): Promise<void> => {
    const recovered = await workspaceAccessor.resetStaleAutoIterationStatuses();
    if (recovered.length > 0) {
      logger.info('Recovered stale auto-iteration states on startup', {
        count: recovered.length,
        workspaceIds: recovered.map((w) => w.id),
      });
    }
  };

  const performCleanup = (): Promise<void> => {
    if (cleanupPromise !== null) {
      return cleanupPromise;
    }

    cleanupStarted = true;
    cleanupPromise = (async () => {
      logger.info('Starting graceful cleanup');

      clearInterval(heartbeatInterval);
      if (indexHtmlReloadInterval !== null) {
        clearInterval(indexHtmlReloadInterval);
        indexHtmlReloadInterval = null;
      }
      await stopInterceptors();

      // Close WebSocket server
      wss.close();
      await closeBoundServer();

      // Stop all Claude clients via sessionService (unified lifecycle management)
      await sessionService.stopAllClients(SHUTDOWN_TIMEOUT_MS);

      terminalService.cleanup();
      sessionFileLogger.cleanup();
      acpTraceLogger.cleanup();
      await rateLimiter.stop();

      await schedulerService.stop();
      stopEventCollector();
      await snapshotReconciliationService.stop();
      await ratchetService.stop();
      await periodicTaskService.stop();
      await reconciliationService.stopPeriodicCleanup();
      await prisma.$disconnect();

      logger.info('Graceful cleanup completed');
    })();

    return cleanupPromise;
  };

  // ============================================================================
  // Return Server Instance
  // ============================================================================
  return {
    async start(): Promise<string> {
      if (cleanupStarted) {
        throw new Error('Server has already been stopped');
      }

      if (explicitStartupStarted) {
        throw new Error('Server startup has already been initiated');
      }

      explicitStartupStarted = true;
      startupComplete = false;

      logger.info('Database path', {
        path: configService.getDatabasePath(),
        source: configService.getDatabasePathFromEnv() ? 'DATABASE_PATH env var' : 'default',
      });

      const runStartupReconciliation = async (): Promise<void> => {
        await runStartupTask('Failed to cleanup orphan sessions on startup', () =>
          reconciliationService.cleanupOrphans()
        );

        // Reset agent sessions that were persisted as RUNNING by a prior process.
        // Live ACP runtimes are in-memory only, so after a backend restart these
        // records must not drive workspace "Working" state.
        await runStartupTask('Failed to recover stale agent sessions on startup', async () => {
          await sessionService.recoverStaleSessionStates();
        });

        // Reconcile workspaces that may have been left in inconsistent states
        // (e.g., stuck in PROVISIONING due to server crash)
        await runStartupTask('Failed to reconcile workspaces on startup', () =>
          reconciliationService.reconcile()
        );

        // Reset run script states left in transient STARTING/STOPPING by a prior crash
        await runStartupTask('Failed to recover stale run script states on startup', () =>
          runScriptStateMachine.recoverStaleStates()
        );

        // Resume workspace archives abandoned by a prior process exit.
        await runStartupTask(
          'Failed to recover stale archiving workspaces on startup',
          recoverStaleArchivingOnStartup
        );

        // Reset auto-iteration states left in RUNNING by a prior crash
        await runStartupTask(
          'Failed to recover stale auto-iteration states on startup',
          recoverStaleAutoIterationOnStartup
        );
      };

      try {
        configureDomainBridges(context.services);
        configureEventCollector(context.services);

        await bindServerWithPortFallback();
        await runStartupReconciliation();

        configureSnapshotReconciliation(context.services);

        logger.info('Backend server started', {
          port: actualPort,
          environment: configService.getEnvironment(),
        });
        if (configService.isRunScriptProxyEnabled()) {
          process.stdout.write(`BACKEND_PORT:${actualPort}\n`);
        }

        sessionFileLogger.cleanupOldLogs();
        acpTraceLogger.cleanupOldLogs();
        await startInterceptors();
        reconciliationService.startPeriodicCleanup();
        rateLimiter.start();
        schedulerService.start();
        ratchetService.start();
        periodicTaskService.start();
        startupComplete = true;

        logger.info('Server endpoints available', {
          server: `http://${ENDPOINT_HOST}:${actualPort}`,
          health: `http://${ENDPOINT_HOST}:${actualPort}/health`,
          healthAll: `http://${ENDPOINT_HOST}:${actualPort}/health/all`,
          trpc: `http://${ENDPOINT_HOST}:${actualPort}/api/trpc`,
          wsChat: `ws://${ENDPOINT_HOST}:${actualPort}/chat`,
          wsTerminal: `ws://${ENDPOINT_HOST}:${actualPort}/terminal`,
          wsSnapshots: `ws://${ENDPOINT_HOST}:${actualPort}/snapshots`,
        });

        return `http://${ENDPOINT_HOST}:${actualPort}`;
      } catch (error) {
        startupComplete = false;
        await performCleanup();
        throw error;
      }
    },

    async stop(): Promise<void> {
      await performCleanup();
    },

    getPort(): number {
      return actualPort;
    },

    getHttpServer(): HttpServer {
      return server;
    },
  };
}
