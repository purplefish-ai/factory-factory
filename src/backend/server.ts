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

import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { WebSocketServer } from 'ws';
import { agentProcessAdapter } from './agents/process-adapter';
import { type AppContext, createAppContext } from './app-context';
import { prisma } from './db';
import { registerInterceptors } from './interceptors';
import {
  createCorsMiddleware,
  createRequestLoggerMiddleware,
  securityMiddleware,
} from './middleware';
import { createHealthRouter } from './routers/api/health.router';
import { createMcpRouter } from './routers/api/mcp.router';
import { createProjectRouter } from './routers/api/project.router';
import { initializeMcpTools } from './routers/mcp/index';
import {
  createChatUpgradeHandler,
  createDevLogsUpgradeHandler,
  createTerminalUpgradeHandler,
} from './routers/websocket';
import { reconciliationService } from './services/reconciliation.service';
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
    ciMonitorService,
    configService,
    createLogger,
    findAvailablePort,
    rateLimiter,
    schedulerService,
    sessionFileLogger,
    sessionService,
    terminalService,
  } = context.services;

  const logger = createLogger('server');
  const REQUESTED_PORT = requestedPort ?? configService.getBackendPort();
  let actualPort: number = REQUESTED_PORT;

  const app = express();

  // Create HTTP server and WebSocket server
  const server = createHttpServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const chatUpgradeHandler = createChatUpgradeHandler(context);
  const terminalUpgradeHandler = createTerminalUpgradeHandler(context);
  const devLogsUpgradeHandler = createDevLogsUpgradeHandler(context);

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

  // ============================================================================
  // Initialize MCP and Interceptors
  // ============================================================================
  initializeMcpTools();
  registerInterceptors();

  // ============================================================================
  // Mount Routers
  // ============================================================================
  app.use('/health', createHealthRouter(context));
  app.use('/mcp', createMcpRouter(context));
  app.use('/api/projects', createProjectRouter(context));
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
  if (frontendStaticPath && existsSync(frontendStaticPath)) {
    logger.info('Serving static files from', { path: frontendStaticPath });

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
        req.path.startsWith('/mcp') ||
        req.path.startsWith('/health') ||
        req.path === '/chat' ||
        req.path === '/terminal' ||
        req.path === '/dev-logs'
      ) {
        return next();
      }
      // Set no-cache headers for index.html so browsers always check for updates
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      // Express 5 requires the root option for sendFile to work correctly
      res.sendFile('index.html', { root: frontendStaticPath }, (err) => {
        if (err) {
          // File not found or read error - log at debug level since this can happen
          // during page refresh timing issues and is usually transient
          logger.debug('Failed to serve index.html for SPA fallback', {
            path: req.path,
            error: err.message,
          });
          // Return 503 to indicate temporary unavailability (browser may retry)
          if (!res.headersSent) {
            res.status(503).send('Service temporarily unavailable. Please refresh the page.');
          }
        }
      });
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
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/chat') {
      chatUpgradeHandler(request, socket, head, url, wss, wsAliveMap);
      return;
    }

    if (url.pathname === '/terminal') {
      terminalUpgradeHandler(request, socket, head, url, wss, wsAliveMap);
      return;
    }

    if (url.pathname === '/dev-logs') {
      devLogsUpgradeHandler(request, socket, head, url, wss, wsAliveMap);
      return;
    }

    socket.destroy();
  });

  // ============================================================================
  // Cleanup Logic
  // ============================================================================
  const SHUTDOWN_TIMEOUT_MS = 5000;

  const performCleanup = async () => {
    logger.info('Starting graceful cleanup');

    clearInterval(heartbeatInterval);

    // Close WebSocket server
    wss.close();
    server.close();

    // Stop all Claude clients via sessionService (unified lifecycle management)
    await sessionService.stopAllClients(SHUTDOWN_TIMEOUT_MS);

    terminalService.cleanup();
    agentProcessAdapter.cleanup();
    sessionFileLogger.cleanup();
    await rateLimiter.stop();

    await schedulerService.stop();
    await ciMonitorService.stop();
    await reconciliationService.stopPeriodicCleanup();
    await prisma.$disconnect();

    logger.info('Graceful cleanup completed');
  };

  // ============================================================================
  // Return Server Instance
  // ============================================================================
  return {
    async start(): Promise<string> {
      actualPort = await findAvailablePort(REQUESTED_PORT);
      if (actualPort !== REQUESTED_PORT) {
        logger.warn('Requested port in use, using alternative', {
          requestedPort: REQUESTED_PORT,
          actualPort,
        });
      }

      return new Promise((resolve, reject) => {
        server.listen(actualPort, async () => {
          logger.info('Backend server started', {
            port: actualPort,
            environment: configService.getEnvironment(),
          });

          // Output port to stdout for CLI to parse (machine-readable format)
          // This must be on its own line starting with BACKEND_PORT: for the CLI to detect
          // biome-ignore lint/suspicious/noConsole: Required for CLI to detect actual backend port
          console.log(`BACKEND_PORT:${actualPort}`);

          try {
            await reconciliationService.cleanupOrphans();
          } catch (error) {
            logger.error('Failed to cleanup orphan sessions on startup', error as Error);
          }

          // Reconcile workspaces that may have been left in inconsistent states
          // (e.g., stuck in PROVISIONING due to server crash)
          try {
            await reconciliationService.reconcile();
          } catch (error) {
            logger.error('Failed to reconcile workspaces on startup', error as Error);
          }

          sessionFileLogger.cleanupOldLogs();
          reconciliationService.startPeriodicCleanup();
          rateLimiter.start();
          schedulerService.start();
          ciMonitorService.start();

          logger.info('Server endpoints available', {
            server: `http://localhost:${actualPort}`,
            health: `http://localhost:${actualPort}/health`,
            healthAll: `http://localhost:${actualPort}/health/all`,
            trpc: `http://localhost:${actualPort}/api/trpc`,
            wsChat: `ws://localhost:${actualPort}/chat`,
            wsTerminal: `ws://localhost:${actualPort}/terminal`,
          });

          resolve(`http://localhost:${actualPort}`);
        });

        server.on('error', (error) => {
          reject(error);
        });
      });
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
