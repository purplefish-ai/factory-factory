import { createServer } from 'node:http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { serve } from 'inngest/express';
import { WebSocketServer } from 'ws';
import {
  listTmuxSessions,
  readSessionOutput,
  tmuxSessionExists,
} from './clients/terminal.client.js';
import { prisma } from './db.js';
import { inngest } from './inngest/client';
import {
  agentCompletedHandler,
  epicCreatedHandler,
  mailSentHandler,
  orchestratorCheckHandler,
  supervisorCheckHandler,
  taskCreatedHandler,
} from './inngest/functions/index.js';
import { epicRouter } from './routers/api/epic.router.js';
import { orchestratorRouter } from './routers/api/orchestrator.router.js';
import { projectRouter } from './routers/api/project.router.js';
import { taskRouter } from './routers/api/task.router.js';
import { executeMcpTool, initializeMcpTools } from './routers/mcp/index.js';
import {
  configService,
  crashRecoveryService,
  createLogger,
  rateLimiter,
} from './services/index.js';
import { appRouter, createContext } from './trpc/index.js';
import * as ptyManager from './websocket/pty-manager.js';
import { connectionParamsSchema } from './websocket/schemas.js';

const logger = createLogger('server');
const app = express();
const PORT = process.env.BACKEND_PORT || 3001;

// Create HTTP server and WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// CORS configuration
const ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:3000',
  'http://localhost:3001',
];

app.use((req, res, next): void => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.path !== '/health' && !req.path.startsWith('/health/')) {
      logger.debug('HTTP request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
      });
    }
  });
  next();
});

app.use(express.json({ limit: '10mb' }));

// Initialize MCP tools
initializeMcpTools();

// ============================================================================
// Health Check Endpoints
// ============================================================================

/**
 * Basic health check - returns OK if server is running
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'factoryfactory-backend',
    version: process.env.npm_package_version || '0.1.0',
    environment: configService.getEnvironment(),
  });
});

/**
 * Database health check
 */
app.get('/health/database', async (_req, res) => {
  try {
    // Simple query to check database connectivity
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      database: 'connected',
    });
  } catch (error) {
    logger.error('Database health check failed', error as Error);
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Inngest health check
 */
app.get('/health/inngest', (_req, res) => {
  // Check if Inngest client is configured
  const hasEventKey = !!process.env.INNGEST_EVENT_KEY || configService.isDevelopment();
  const hasSigningKey = !!process.env.INNGEST_SIGNING_KEY || configService.isDevelopment();

  const status = hasEventKey && hasSigningKey ? 'ok' : 'degraded';

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    inngest: {
      eventKeyConfigured: hasEventKey,
      signingKeyConfigured: hasSigningKey,
      mode: configService.isDevelopment() ? 'development' : 'production',
    },
  });
});

/**
 * Agent health summary
 */
app.get('/health/agents', async (_req, res) => {
  try {
    const healthStatus = await crashRecoveryService.getSystemHealthStatus();
    const apiUsage = rateLimiter.getApiUsageStats();
    const concurrency = rateLimiter.getConcurrencyStats();

    const status = healthStatus.isHealthy ? 'ok' : 'degraded';

    res.status(status === 'ok' ? 200 : 503).json({
      status,
      timestamp: new Date().toISOString(),
      agents: {
        orchestratorHealthy: healthStatus.orchestratorHealthy,
        supervisors: {
          total: healthStatus.supervisorCount,
          healthy: healthStatus.healthySupervisors,
        },
        workers: {
          total: healthStatus.workerCount,
          healthy: healthStatus.healthyWorkers,
        },
        crashLoopAgents: healthStatus.crashLoopAgents,
      },
      apiUsage: {
        requestsLastMinute: apiUsage.requestsLastMinute,
        requestsLastHour: apiUsage.requestsLastHour,
        isRateLimited: apiUsage.isRateLimited,
        queueDepth: apiUsage.queueDepth,
      },
      concurrency: {
        activeWorkers: concurrency.activeWorkers,
        activeSupervisors: concurrency.activeSupervisors,
        activeEpics: concurrency.activeEpics,
      },
      issues: healthStatus.issues,
    });
  } catch (error) {
    logger.error('Agent health check failed', error as Error);
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Comprehensive health check (all systems)
 */
app.get('/health/all', async (_req, res) => {
  const checks: Record<string, { status: string; details?: unknown }> = {};

  // Database check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: 'ok' };
  } catch (error) {
    checks.database = {
      status: 'error',
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Agent check
  try {
    const healthStatus = await crashRecoveryService.getSystemHealthStatus();
    checks.agents = {
      status: healthStatus.isHealthy ? 'ok' : 'degraded',
      details: {
        orchestratorHealthy: healthStatus.orchestratorHealthy,
        healthySupervisors: healthStatus.healthySupervisors,
        healthyWorkers: healthStatus.healthyWorkers,
        issues: healthStatus.issues,
      },
    };
  } catch {
    checks.agents = { status: 'error' };
  }

  // Inngest check
  const hasInngestKeys =
    (!!process.env.INNGEST_EVENT_KEY && !!process.env.INNGEST_SIGNING_KEY) ||
    configService.isDevelopment();
  checks.inngest = {
    status: hasInngestKeys ? 'ok' : 'degraded',
  };

  // Rate limiter check
  const apiUsage = rateLimiter.getApiUsageStats();
  checks.rateLimiter = {
    status: apiUsage.isRateLimited ? 'degraded' : 'ok',
    details: {
      requestsLastMinute: apiUsage.requestsLastMinute,
      isRateLimited: apiUsage.isRateLimited,
    },
  };

  // Determine overall status
  const statuses = Object.values(checks).map((c) => c.status);
  let overallStatus = 'ok';
  if (statuses.includes('error')) {
    overallStatus = 'error';
  } else if (statuses.includes('degraded')) {
    overallStatus = 'degraded';
  }

  res.status(overallStatus === 'error' ? 503 : 200).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
  });
});

// ============================================================================
// MCP Tool Execution
// ============================================================================

app.post('/mcp/execute', async (req, res) => {
  try {
    const { agentId, toolName, input } = req.body;

    // Validate required fields
    if (!agentId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required field: agentId',
        },
      });
    }

    if (!toolName) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required field: toolName',
        },
      });
    }

    // Execute the tool
    const result = await executeMcpTool(agentId, toolName, input || {});

    // Return result with appropriate status code
    const statusCode = result.success ? 200 : 400;
    return res.status(statusCode).json(result);
  } catch (error) {
    logger.error('Error executing MCP tool', error as Error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
});

// ============================================================================
// API Routes
// ============================================================================

// Project API routes
app.use('/api/projects', projectRouter);

// Task API routes
app.use('/api/tasks', taskRouter);

// Epic API routes
app.use('/api/epics', epicRouter);

// Orchestrator API routes
app.use('/api/orchestrator', orchestratorRouter);

// Inngest webhook handler
app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions: [
      mailSentHandler,
      taskCreatedHandler,
      epicCreatedHandler,
      agentCompletedHandler,
      supervisorCheckHandler,
      orchestratorCheckHandler,
    ],
  })
);

// tRPC API endpoint
app.use(
  '/api/trpc',
  createExpressMiddleware({
    router: appRouter,
    createContext,
  })
);

// ============================================================================
// Terminal API Endpoints
// ============================================================================

app.get('/api/terminal/sessions', async (_req, res) => {
  try {
    const sessions = await listTmuxSessions();
    res.json({ sessions });
  } catch (error) {
    logger.error('Error listing tmux sessions', error as Error);
    res.status(500).json({
      error: 'Failed to list tmux sessions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/terminal/session/:sessionName/output', async (req, res) => {
  try {
    const { sessionName } = req.params;
    const output = await readSessionOutput(sessionName);
    res.json({ output, sessionName });
  } catch (error) {
    logger.error('Error reading session output', error as Error);
    res.status(500).json({
      error: 'Failed to read session output',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// Error Handling
// ============================================================================

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', err);
  res.status(500).json({
    error: 'Internal server error',
    message: configService.isDevelopment() ? err.message : 'An unexpected error occurred',
  });
});

// ============================================================================
// WebSocket Terminal Handler
// ============================================================================

// Handle WebSocket upgrade requests for /terminal path
server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);

  // Only handle /terminal path
  if (url.pathname !== '/terminal') {
    socket.destroy();
    return;
  }

  try {
    // Parse and validate connection parameters
    const params = connectionParamsSchema.safeParse({
      session: url.searchParams.get('session'),
      cols: url.searchParams.get('cols'),
      rows: url.searchParams.get('rows'),
    });

    if (!params.success) {
      logger.warn('Invalid terminal connection parameters', {
        issues: params.error.issues,
      });
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const { session, cols, rows } = params.data;

    // Verify tmux session exists
    const sessionExists = await tmuxSessionExists(session);
    if (!sessionExists) {
      logger.warn('Tmux session not found', { session });
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Complete the WebSocket handshake
    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info('WebSocket connection established', { session, cols, rows });

      // Attach PTY to the tmux session
      const result = ptyManager.attach(session, ws, cols, rows);

      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', message: result.error }));
        ws.close(1008, result.error);
        return;
      }

      // Handle incoming messages
      ws.on('message', (data) => {
        const message = data.toString();
        ptyManager.handleMessage(ws, message);
      });

      // Handle connection close
      ws.on('close', () => {
        logger.info('WebSocket connection closed', { session });
        ptyManager.cleanup(ws);
      });

      // Handle connection errors
      ws.on('error', (error) => {
        logger.error('WebSocket error', error);
        ptyManager.cleanup(ws);
      });
    });
  } catch (error) {
    logger.error('Error handling WebSocket upgrade', error as Error);
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  }
});

// WebSocket connection stats endpoint
app.get('/api/terminal/stats', (_req, res) => {
  const stats = ptyManager.getStats();
  res.json(stats);
});

// ============================================================================
// Server Startup
// ============================================================================

server.listen(PORT, () => {
  logger.info('Backend server started', {
    port: PORT,
    environment: configService.getEnvironment(),
  });
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Health check (all): http://localhost:${PORT}/health/all`);
  console.log(`Inngest endpoint: http://localhost:${PORT}/api/inngest`);
  console.log(`tRPC endpoint: http://localhost:${PORT}/api/trpc`);
  console.log(`WebSocket terminal: ws://localhost:${PORT}/terminal`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  ptyManager.cleanupAll();
  wss.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  ptyManager.cleanupAll();
  wss.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});
