import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { serve } from 'inngest/express';
import { WebSocketServer } from 'ws';
import {
  claudeStreamingClient,
  getSessionHistory,
  listSessions,
} from './clients/claude-streaming.client.js';
import { prisma } from './db.js';
import { inngest } from './inngest/client';
import {
  agentCompletedHandler,
  mailSentHandler,
  orchestratorCheckHandler,
  supervisorCheckHandler,
  taskCreatedHandler,
  topLevelTaskCreatedHandler,
} from './inngest/functions/index.js';
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

const logger = createLogger('server');
const app = express();
const PORT = process.env.BACKEND_PORT || 3001;

// Create HTTP server and WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Security headers middleware
app.use((_req, res, next) => {
  // Prevent MIME type sniffing
  res.header('X-Content-Type-Options', 'nosniff');
  // Prevent clickjacking
  res.header('X-Frame-Options', 'DENY');
  // XSS protection (legacy but still useful)
  res.header('X-XSS-Protection', '1; mode=block');
  // Referrer policy
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

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
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Project-Id, X-Top-Level-Task-Id'
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
        activeTopLevelTasks: concurrency.activeTopLevelTasks,
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
      topLevelTaskCreatedHandler,
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
// WebSocket Chat Handler (Claude CLI JSON Streaming)
// ============================================================================

// Track WebSocket connections per session
const chatConnections = new Map<string, Set<import('ws').WebSocket>>();

// Forward Claude process events to connected WebSocket clients
claudeStreamingClient.on('message', ({ sessionId, message }) => {
  const connections = chatConnections.get(sessionId);
  if (connections) {
    const data = JSON.stringify({ type: 'claude_message', data: message });
    for (const ws of connections) {
      if (ws.readyState === 1) {
        // WebSocket.OPEN
        ws.send(data);
      }
    }
  }
});

claudeStreamingClient.on('stderr', ({ sessionId, data }) => {
  const connections = chatConnections.get(sessionId);
  if (connections) {
    const message = JSON.stringify({ type: 'stderr', data });
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(message);
      }
    }
  }
});

claudeStreamingClient.on('exit', ({ sessionId, code, claudeSessionId }) => {
  const connections = chatConnections.get(sessionId);
  if (connections) {
    const message = JSON.stringify({ type: 'process_exit', code, claudeSessionId });
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(message);
      }
    }
  }
});

claudeStreamingClient.on('error', ({ sessionId, error }) => {
  const connections = chatConnections.get(sessionId);
  if (connections) {
    const message = JSON.stringify({ type: 'error', message: error.message });
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(message);
      }
    }
  }
});

// Handle individual chat messages
async function handleChatMessage(
  ws: import('ws').WebSocket,
  sessionId: string,
  workingDir: string,
  message: {
    type: string;
    text?: string;
    workingDir?: string;
    resumeSessionId?: string;
    systemPrompt?: string;
    model?: string;
    claudeSessionId?: string;
  }
) {
  switch (message.type) {
    case 'start':
      if (!claudeStreamingClient.isRunning(sessionId)) {
        await claudeStreamingClient.startProcess({
          sessionId,
          workingDir: message.workingDir || workingDir,
          resumeSessionId: message.resumeSessionId,
          systemPrompt: message.systemPrompt,
          model: message.model,
        });
        ws.send(JSON.stringify({ type: 'started', sessionId }));
      }
      break;

    case 'user_input':
      handleUserInput(sessionId, workingDir, message.text || '');
      break;

    case 'stop':
      claudeStreamingClient.killProcess(sessionId);
      ws.send(JSON.stringify({ type: 'stopped', sessionId }));
      break;

    case 'get_history': {
      const claudeSessionId = claudeStreamingClient.getClaudeSessionId(sessionId);
      if (claudeSessionId) {
        const history = await getSessionHistory(claudeSessionId, workingDir);
        ws.send(JSON.stringify({ type: 'history', sessionId, messages: history }));
      } else {
        ws.send(JSON.stringify({ type: 'history', sessionId, messages: [] }));
      }
      break;
    }

    case 'list_sessions': {
      const sessions = await listSessions(workingDir);
      ws.send(JSON.stringify({ type: 'sessions', sessions }));
      break;
    }

    case 'load_session': {
      const targetSessionId = message.claudeSessionId;
      if (targetSessionId) {
        // Set the Claude session ID so future messages resume this session
        claudeStreamingClient.setClaudeSessionId(sessionId, targetSessionId);
        // Get the history
        const history = await getSessionHistory(targetSessionId, workingDir);
        ws.send(
          JSON.stringify({
            type: 'session_loaded',
            claudeSessionId: targetSessionId,
            messages: history,
          })
        );
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'claudeSessionId required' }));
      }
      break;
    }
  }
}

/**
 * Handle user input message.
 * Note: startProcess is synchronous but spawn errors are emitted asynchronously
 * via the 'error' event on the process. Error handling is done in setupListeners.
 */
function handleUserInput(sessionId: string, workingDir: string, text: string) {
  if (!text) {
    return;
  }

  // Ensure process is running (startProcess is idempotent - returns existing if already running)
  claudeStreamingClient.startProcess({
    sessionId,
    workingDir,
  });

  // Send message to the process via stdin
  claudeStreamingClient.sendMessage(sessionId, text);
}

/**
 * Validate that workingDir is safe (no path traversal).
 * Returns resolved path if valid, or null if invalid.
 */
function validateWorkingDir(workingDir: string): string | null {
  const baseDir = process.cwd();
  const resolved = resolve(baseDir, workingDir);

  // Ensure the resolved path is within the base directory
  // or is the base directory itself
  if (!resolved.startsWith(baseDir)) {
    return null;
  }

  // Reject paths with obvious traversal attempts
  if (workingDir.includes('..')) {
    return null;
  }

  return resolved;
}

// ============================================================================
// WebSocket Agent Activity Handler
// ============================================================================

// Track WebSocket connections per agent
const agentActivityConnections = new Map<string, Set<import('ws').WebSocket>>();

// Forward Claude process events to agent activity WebSocket clients
// (Uses same event handlers as chat since they share the claudeStreamingClient)

/**
 * Calculate health status for an agent
 */
function calculateAgentHealth(agent: {
  lastHeartbeat: Date | null;
  createdAt: Date;
  executionState: string;
}): {
  isHealthy: boolean;
  minutesSinceHeartbeat: number;
} {
  const config = configService.getSystemConfig();
  const healthThresholdMinutes = config.agentHeartbeatThresholdMinutes;
  const now = Date.now();
  const heartbeatTime = agent.lastHeartbeat ?? agent.createdAt;
  const minutesSinceHeartbeat = Math.floor((now - heartbeatTime.getTime()) / (60 * 1000));
  const isHealthy =
    minutesSinceHeartbeat < healthThresholdMinutes && agent.executionState !== 'CRASHED';
  return { isHealthy, minutesSinceHeartbeat };
}

/**
 * Build agent metadata for WebSocket response
 */
async function buildAgentMetadata(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    include: {
      currentTask: true,
      assignedTasks: {
        select: { id: true, title: true, state: true },
      },
    },
  });

  if (!agent) {
    return null;
  }

  const { isHealthy, minutesSinceHeartbeat } = calculateAgentHealth(agent);

  return {
    id: agent.id,
    type: agent.type,
    executionState: agent.executionState,
    desiredExecutionState: agent.desiredExecutionState,
    worktreePath: agent.worktreePath,
    sessionId: agent.sessionId,
    tmuxSessionName: agent.tmuxSessionName,
    cliProcessId: agent.cliProcessId,
    cliProcessStatus: agent.cliProcessStatus,
    isHealthy,
    minutesSinceHeartbeat,
    currentTask: agent.currentTask
      ? {
          id: agent.currentTask.id,
          title: agent.currentTask.title,
          state: agent.currentTask.state,
          branchName: agent.currentTask.branchName,
          prUrl: agent.currentTask.prUrl,
        }
      : null,
    assignedTasks: agent.assignedTasks,
  };
}

// Handle agent activity WebSocket upgrade
async function handleAgentActivityUpgrade(
  request: import('http').IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
  url: URL
) {
  const agentId = url.searchParams.get('agentId');

  if (!agentId) {
    logger.warn('Agent activity WebSocket: missing agentId');
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Look up agent to get workingDir (worktreePath)
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
  });

  if (!agent) {
    logger.warn('Agent activity WebSocket: agent not found', { agentId });
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Use agent's worktreePath or fall back to cwd
  const workingDir = agent.worktreePath || process.cwd();

  // Use agent's session ID or cliProcessId as the session key
  const sessionId = agent.cliProcessId || agent.sessionId || `agent-${agentId}`;

  wss.handleUpgrade(request, socket, head, async (ws) => {
    logger.info('Agent activity WebSocket connection established', { agentId, sessionId });

    // Track this connection for agent activity
    if (!agentActivityConnections.has(agentId)) {
      agentActivityConnections.set(agentId, new Set());
    }
    agentActivityConnections.get(agentId)?.add(ws);

    // Also track in chatConnections so we receive claude events
    if (!chatConnections.has(sessionId)) {
      chatConnections.set(sessionId, new Set());
    }
    chatConnections.get(sessionId)?.add(ws);

    // If agent has a session ID, store it for resuming
    if (agent.sessionId) {
      claudeStreamingClient.setClaudeSessionId(sessionId, agent.sessionId);
    }

    // Build and send agent metadata
    const agentMetadata = await buildAgentMetadata(agentId);

    // Send initial status with agent metadata
    ws.send(
      JSON.stringify({
        type: 'status',
        agentId,
        sessionId,
        running: claudeStreamingClient.isRunning(sessionId),
        claudeSessionId: claudeStreamingClient.getClaudeSessionId(sessionId),
        agentMetadata,
      })
    );

    // If agent has a session ID, try to load history
    if (agent.sessionId) {
      try {
        const history = await getSessionHistory(agent.sessionId, workingDir);
        if (history.length > 0) {
          ws.send(
            JSON.stringify({
              type: 'session_loaded',
              claudeSessionId: agent.sessionId,
              messages: history,
            })
          );
        }
      } catch (error) {
        logger.warn('Error loading agent session history', { agentId, error });
      }
    }

    // Handle connection close
    ws.on('close', () => {
      logger.info('Agent activity WebSocket connection closed', { agentId, sessionId });

      // Clean up agent activity connections
      const agentConns = agentActivityConnections.get(agentId);
      if (agentConns) {
        agentConns.delete(ws);
        if (agentConns.size === 0) {
          agentActivityConnections.delete(agentId);
        }
      }

      // Clean up chat connections
      const chatConns = chatConnections.get(sessionId);
      if (chatConns) {
        chatConns.delete(ws);
        if (chatConns.size === 0) {
          chatConnections.delete(sessionId);
        }
      }
    });

    // Handle connection errors
    ws.on('error', (error) => {
      logger.error('Agent activity WebSocket error', error);
    });
  });
}

// Handle chat WebSocket upgrade
function handleChatUpgrade(
  request: import('http').IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
  url: URL
) {
  const sessionId = url.searchParams.get('sessionId') || `chat-${Date.now()}`;
  const rawWorkingDir = url.searchParams.get('workingDir') || process.cwd();
  const claudeSessionId = url.searchParams.get('claudeSessionId');

  // Validate workingDir to prevent path traversal
  const workingDir = validateWorkingDir(rawWorkingDir);
  if (!workingDir) {
    logger.warn('Invalid workingDir rejected', { rawWorkingDir, sessionId });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info('Chat WebSocket connection established', { sessionId, claudeSessionId });

    // If a Claude session ID was provided, store it for resuming
    if (claudeSessionId) {
      claudeStreamingClient.setClaudeSessionId(sessionId, claudeSessionId);
    }

    // Track this connection
    if (!chatConnections.has(sessionId)) {
      chatConnections.set(sessionId, new Set());
    }
    chatConnections.get(sessionId)?.add(ws);

    // Send initial status
    ws.send(
      JSON.stringify({
        type: 'status',
        sessionId,
        running: claudeStreamingClient.isRunning(sessionId),
        claudeSessionId: claudeStreamingClient.getClaudeSessionId(sessionId),
      })
    );

    // Handle incoming messages from client
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleChatMessage(ws, sessionId, workingDir, message);
      } catch (error) {
        logger.error('Error handling chat message', error as Error);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    // Handle connection close
    ws.on('close', () => {
      logger.info('Chat WebSocket connection closed', { sessionId });
      const connections = chatConnections.get(sessionId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          chatConnections.delete(sessionId);
        }
      }
    });

    // Handle connection errors
    ws.on('error', (error) => {
      logger.error('Chat WebSocket error', error);
    });
  });
}

// ============================================================================
// WebSocket Upgrade Handler
// ============================================================================

// Handle WebSocket upgrade requests
server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);

  // Route to appropriate handler based on path
  if (url.pathname === '/chat') {
    handleChatUpgrade(request, socket, head, url);
    return;
  }

  if (url.pathname === '/agent-activity') {
    await handleAgentActivityUpgrade(request, socket, head, url);
    return;
  }

  // Unknown WebSocket path
  socket.destroy();
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
  console.log(`WebSocket chat: ws://localhost:${PORT}/chat`);
  console.log(`WebSocket agent-activity: ws://localhost:${PORT}/agent-activity`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  claudeStreamingClient.cleanupAll();
  wss.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  claudeStreamingClient.cleanupAll();
  wss.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});
