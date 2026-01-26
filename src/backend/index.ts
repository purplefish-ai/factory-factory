import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { serve } from 'inngest/express';
import { WebSocketServer } from 'ws';
import { agentProcessAdapter } from './agents/process-adapter.js';
import { ClaudeClient, type ClaudeClientOptions, SessionManager } from './claude/index.js';
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
import { chatSessionSettingsAccessor } from './resource_accessors/chat-session-settings.accessor.js';
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

// ============================================================================
// Chat Client Manager
// ============================================================================

// Simple manager for chat WebSocket clients
const chatClients = new Map<string, ClaudeClient>();
// Track pending client creation to prevent duplicate creation from race conditions
const pendingClientCreation = new Map<string, Promise<ClaudeClient>>();

// Debug logging for chat websocket
const DEBUG_CHAT_WS = true;
let chatWsMsgCounter = 0;

// ============================================================================
// Session File Logger
// ============================================================================

/**
 * Logs WebSocket events to a per-session file for debugging.
 * Log files are stored in .context/ws-logs/<session-id>.log
 */
class SessionFileLogger {
  private logDir: string;
  private sessionLogs = new Map<string, string>(); // sessionId -> logFilePath

  constructor() {
    this.logDir = join(process.cwd(), '.context', 'ws-logs');
    // Ensure log directory exists
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Initialize a log file for a session
   */
  initSession(sessionId: string): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
    const logFile = join(this.logDir, `${safeSessionId}_${timestamp}.log`);
    this.sessionLogs.set(sessionId, logFile);

    // Write header
    const header = [
      '='.repeat(80),
      `WebSocket Session Log`,
      `Session ID: ${sessionId}`,
      `Started: ${new Date().toISOString()}`,
      `Log File: ${logFile}`,
      '='.repeat(80),
      '',
    ].join('\n');

    writeFileSync(logFile, header);
    logger.info('[SessionFileLogger] Created log file', { sessionId, logFile });
  }

  /**
   * Log a message to the session's log file
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: debug logging with intentional branching for summary extraction
  log(
    sessionId: string,
    direction: 'OUT_TO_CLIENT' | 'IN_FROM_CLIENT' | 'FROM_CLAUDE_CLI' | 'INFO',
    data: unknown
  ): void {
    const logFile = this.sessionLogs.get(sessionId);
    if (!logFile) {
      return;
    }

    const timestamp = new Date().toISOString();
    const directionIcon =
      direction === 'OUT_TO_CLIENT'
        ? '⬆️ OUT→CLIENT'
        : direction === 'IN_FROM_CLIENT'
          ? '⬇️ IN←CLIENT'
          : direction === 'FROM_CLAUDE_CLI'
            ? '📥 FROM_CLI'
            : 'ℹ️  INFO';

    // Extract summary info for quick scanning
    let summary = '';
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      summary = `type=${String(obj.type ?? 'unknown')}`;

      // For claude_message, extract inner type
      if (obj.type === 'claude_message' && obj.data) {
        const innerData = obj.data as Record<string, unknown>;
        summary += ` inner_type=${String(innerData.type ?? 'unknown')}`;

        // For stream events, extract event type
        if (innerData.type === 'stream_event' && innerData.event) {
          const event = innerData.event as Record<string, unknown>;
          summary += ` event_type=${String(event.type ?? 'unknown')}`;
          if (event.content_block) {
            const block = event.content_block as Record<string, unknown>;
            summary += ` block_type=${String(block.type ?? 'unknown')}`;
            if (block.name) {
              summary += ` tool=${String(block.name)}`;
            }
          }
        }

        // For user messages with tool_result
        if (innerData.type === 'user' && innerData.message) {
          const msg = innerData.message as { content?: Array<{ type?: string }> };
          if (Array.isArray(msg.content)) {
            const types = msg.content.map((c) => c.type).join(',');
            summary += ` content_types=[${types}]`;
          }
        }

        // For result messages
        if (innerData.type === 'result') {
          summary += ` result_present=${innerData.result != null}`;
        }
      }
    }

    const logEntry = [
      '-'.repeat(80),
      `[${timestamp}] ${directionIcon}`,
      `Summary: ${summary}`,
      'Full Data:',
      JSON.stringify(data, null, 2),
      '',
    ].join('\n');

    try {
      appendFileSync(logFile, logEntry);
    } catch (error) {
      logger.error('[SessionFileLogger] Failed to write log', { sessionId, error });
    }
  }

  /**
   * Close a session's log file
   */
  closeSession(sessionId: string): void {
    const logFile = this.sessionLogs.get(sessionId);
    if (logFile) {
      const footer = [
        '',
        '='.repeat(80),
        `Session ended: ${new Date().toISOString()}`,
        '='.repeat(80),
      ].join('\n');

      try {
        appendFileSync(logFile, footer);
      } catch {
        // Ignore errors on close
      }

      this.sessionLogs.delete(sessionId);
      logger.info('[SessionFileLogger] Closed log file', { sessionId, logFile });
    }
  }
}

// Global session file logger instance
const sessionFileLogger = new SessionFileLogger();

// Helper to forward data to WebSocket connections for a session
function forwardToConnections(sessionId: string, data: unknown): void {
  const connections = chatConnections.get(sessionId);
  if (connections) {
    chatWsMsgCounter++;
    const msgNum = chatWsMsgCounter;

    if (DEBUG_CHAT_WS) {
      const dataObj = data as { type?: string; data?: { type?: string; uuid?: string } };
      logger.info(`[Chat WS #${msgNum}] Sending to ${connections.size} connection(s)`, {
        sessionId,
        type: dataObj.type,
        innerType: dataObj.data?.type,
        uuid: dataObj.data?.uuid,
      });
    }

    // Log to session file
    sessionFileLogger.log(sessionId, 'OUT_TO_CLIENT', data);

    const json = JSON.stringify(data);
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(json);
      }
    }
  }
}

// Set up event forwarding from ClaudeClient to WebSocket connections
function setupChatClientEvents(sessionId: string, client: ClaudeClient): void {
  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Setting up event forwarding for session', { sessionId });
  }

  // Forward stream events for real-time content (text deltas, tool_use blocks).
  // Note: We skip 'assistant' messages as they duplicate stream event content.
  // However, we DO forward 'user' messages that contain tool_result content,
  // as these are NOT duplicated by stream events and are needed for the UI
  // to show tool completion status.

  client.on('stream', (event) => {
    if (DEBUG_CHAT_WS) {
      const evt = event as { type?: string };
      logger.info('[Chat WS] Received stream event from client', {
        sessionId,
        eventType: evt.type,
      });
    }
    // Log the raw event from CLI before wrapping
    sessionFileLogger.log(sessionId, 'FROM_CLAUDE_CLI', { eventType: 'stream', data: event });
    forwardToConnections(sessionId, { type: 'claude_message', data: event });
  });

  // Forward user messages that contain tool_result content.
  // This allows the frontend to pair tool_use with tool_result and show correct status.
  client.on('message', (msg) => {
    // Log ALL messages from CLI (even ones we don't forward)
    sessionFileLogger.log(sessionId, 'FROM_CLAUDE_CLI', { eventType: 'message', data: msg });

    // Only forward user messages with tool_result content
    // Skip assistant messages as they duplicate stream events
    const msgWithType = msg as { type?: string; message?: { content?: Array<{ type?: string }> } };
    if (msgWithType.type !== 'user') {
      sessionFileLogger.log(sessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'not_user_type',
        type: msgWithType.type,
      });
      return;
    }

    // Check if this user message contains tool_result
    const content = msgWithType.message?.content;
    if (!Array.isArray(content)) {
      sessionFileLogger.log(sessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'no_array_content',
      });
      return;
    }

    const hasToolResult = content.some((item) => item.type === 'tool_result');
    if (!hasToolResult) {
      sessionFileLogger.log(sessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'no_tool_result_content',
        content_types: content.map((c) => c.type),
      });
      return;
    }

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Forwarding user message with tool_result', { sessionId });
    }
    sessionFileLogger.log(sessionId, 'INFO', {
      action: 'forwarding_user_message_with_tool_result',
    });
    forwardToConnections(sessionId, { type: 'claude_message', data: msg });
  });

  // Forward result events to signal turn completion
  // This allows the frontend to know when Claude is done responding
  client.on('result', (result) => {
    if (DEBUG_CHAT_WS) {
      const res = result as { uuid?: string };
      logger.info('[Chat WS] Received result event from client', { sessionId, uuid: res.uuid });
    }
    // Log the raw result from CLI
    sessionFileLogger.log(sessionId, 'FROM_CLAUDE_CLI', { eventType: 'result', data: result });
    forwardToConnections(sessionId, { type: 'claude_message', data: result });
  });

  client.on('exit', (result) => {
    forwardToConnections(sessionId, {
      type: 'process_exit',
      code: result.code,
      claudeSessionId: result.sessionId,
    });
    chatClients.delete(sessionId);
  });

  client.on('error', (error) => {
    forwardToConnections(sessionId, { type: 'error', message: error.message });
  });
}

// Get or create a chat client for a session
async function getOrCreateChatClient(
  sessionId: string,
  options: {
    workingDir: string;
    resumeSessionId?: string;
    systemPrompt?: string;
    model?: string;
    thinkingEnabled?: boolean;
    permissionMode?: 'bypassPermissions' | 'plan';
  }
): Promise<ClaudeClient> {
  // Check for existing running client
  let client = chatClients.get(sessionId);
  if (client?.isRunning()) {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Reusing existing running client', { sessionId });
    }
    return client;
  }

  // Check if there's already a pending creation for this session (race condition prevention)
  const pendingCreation = pendingClientCreation.get(sessionId);
  if (pendingCreation) {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Waiting for pending client creation', { sessionId });
    }
    return pendingCreation;
  }

  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Creating new client', {
      sessionId,
      hadExistingClient: !!client,
      resumeSessionId: options.resumeSessionId,
    });
  }

  // Create the client and track the promise to prevent duplicate creation
  const createPromise = (async () => {
    const clientOptions: ClaudeClientOptions = {
      workingDir: options.workingDir,
      resumeSessionId: options.resumeSessionId,
      systemPrompt: options.systemPrompt,
      model: options.model,
      permissionMode: options.permissionMode ?? 'bypassPermissions',
      includePartialMessages: true, // Enable streaming events for real-time UI updates
      thinkingEnabled: options.thinkingEnabled,
    };

    const newClient = await ClaudeClient.create(clientOptions);

    // Set up event forwarding before storing in map to ensure events aren't missed
    setupChatClientEvents(sessionId, newClient);
    chatClients.set(sessionId, newClient);

    return newClient;
  })();

  pendingClientCreation.set(sessionId, createPromise);

  try {
    client = await createPromise;
    return client;
  } finally {
    pendingClientCreation.delete(sessionId);
  }
}

// ============================================================================
// Agent Process Event Forwarding
// ============================================================================

// Forward agent process events to agent activity WebSocket clients
agentProcessAdapter.on('message', ({ agentId, message }) => {
  // Skip 'assistant' and 'user' messages - they duplicate the content from stream events.
  // Stream events provide real-time updates; the final assistant message is redundant.
  // The TypeScript types for message are ClaudeJson which includes type field.
  const msgType = (message as { type?: string }).type;
  if (msgType === 'assistant' || msgType === 'user') {
    return;
  }

  const connections = agentActivityConnections.get(agentId);
  if (connections) {
    const data = JSON.stringify({ type: 'claude_message', data: message });
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }
});

// Forward result events to signal turn completion
agentProcessAdapter.on(
  'result',
  ({ agentId, sessionId, claudeSessionId, usage, durationMs, numTurns }) => {
    const connections = agentActivityConnections.get(agentId);
    if (connections) {
      // Forward as a ClaudeMessage with type 'result' so the frontend can detect turn completion
      const resultMessage = {
        type: 'result' as const,
        session_id: claudeSessionId || sessionId,
        usage,
        duration_ms: durationMs,
        num_turns: numTurns,
      };
      const data = JSON.stringify({ type: 'claude_message', data: resultMessage });
      for (const ws of connections) {
        if (ws.readyState === 1) {
          ws.send(data);
        }
      }
    }
  }
);

agentProcessAdapter.on('exit', ({ agentId, code, sessionId }) => {
  const connections = agentActivityConnections.get(agentId);
  if (connections) {
    const data = JSON.stringify({ type: 'process_exit', code, claudeSessionId: sessionId });
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }
});

agentProcessAdapter.on('error', ({ agentId, error }) => {
  const connections = agentActivityConnections.get(agentId);
  if (connections) {
    const data = JSON.stringify({ type: 'error', message: error.message });
    for (const ws of connections) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  }
});

// Handle individual chat messages
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: handles multiple message types with settings
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
    // Settings fields
    thinkingEnabled?: boolean;
    planModeEnabled?: boolean;
    selectedModel?: string | null;
  }
) {
  switch (message.type) {
    case 'start': {
      // Map planModeEnabled to permissionMode
      const permissionMode = message.planModeEnabled ? 'plan' : 'bypassPermissions';

      await getOrCreateChatClient(sessionId, {
        workingDir: message.workingDir || workingDir,
        resumeSessionId: message.resumeSessionId,
        systemPrompt: message.systemPrompt,
        model: message.selectedModel || message.model,
        thinkingEnabled: message.thinkingEnabled,
        permissionMode,
      });
      ws.send(JSON.stringify({ type: 'started', sessionId }));
      break;
    }

    case 'user_input': {
      const client = chatClients.get(sessionId);
      if (client) {
        client.sendMessage(message.text || '');
      } else {
        // Auto-start if not running
        const newClient = await getOrCreateChatClient(sessionId, { workingDir });
        newClient.sendMessage(message.text || '');
      }
      break;
    }

    case 'stop': {
      const client = chatClients.get(sessionId);
      if (client) {
        client.kill();
        chatClients.delete(sessionId);
      }
      ws.send(JSON.stringify({ type: 'stopped', sessionId }));
      break;
    }

    case 'get_history': {
      const client = chatClients.get(sessionId);
      const claudeSessionId = client?.getSessionId();
      if (claudeSessionId) {
        const history = await SessionManager.getHistory(claudeSessionId, workingDir);
        ws.send(JSON.stringify({ type: 'history', sessionId, messages: history }));
      } else {
        ws.send(JSON.stringify({ type: 'history', sessionId, messages: [] }));
      }
      break;
    }

    case 'list_sessions': {
      const sessions = await SessionManager.listSessions(workingDir);
      ws.send(JSON.stringify({ type: 'sessions', sessions }));
      break;
    }

    case 'load_session': {
      // Load session history without starting a process
      const targetSessionId = message.claudeSessionId;
      if (targetSessionId) {
        const [history, settings, gitBranch] = await Promise.all([
          SessionManager.getHistory(targetSessionId, workingDir),
          chatSessionSettingsAccessor.getOrCreate(targetSessionId),
          SessionManager.getSessionGitBranch(targetSessionId, workingDir),
        ]);
        ws.send(
          JSON.stringify({
            type: 'session_loaded',
            claudeSessionId: targetSessionId,
            messages: history,
            gitBranch,
            settings: {
              selectedModel: settings.selectedModel,
              thinkingEnabled: settings.thinkingEnabled,
              planModeEnabled: settings.planModeEnabled,
            },
          })
        );
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'claudeSessionId required' }));
      }
      break;
    }

    case 'update_settings': {
      // Update settings for the current session
      const targetSessionId = message.claudeSessionId;
      if (targetSessionId) {
        const updatedSettings = await chatSessionSettingsAccessor.update(targetSessionId, {
          selectedModel: message.selectedModel,
          thinkingEnabled: message.thinkingEnabled,
          planModeEnabled: message.planModeEnabled,
        });
        ws.send(
          JSON.stringify({
            type: 'settings_updated',
            claudeSessionId: targetSessionId,
            settings: {
              selectedModel: updatedSettings.selectedModel,
              thinkingEnabled: updatedSettings.thinkingEnabled,
              planModeEnabled: updatedSettings.planModeEnabled,
            },
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

    // Build and send agent metadata
    const agentMetadata = await buildAgentMetadata(agentId);

    // Get running status from agentProcessAdapter
    const isRunning = agentProcessAdapter.isRunning(agentId);
    const claudeSessionId = agentProcessAdapter.getClaudeSessionId(agentId) ?? agent.sessionId;

    // Send initial status with agent metadata
    ws.send(
      JSON.stringify({
        type: 'status',
        agentId,
        sessionId,
        running: isRunning,
        claudeSessionId,
        agentMetadata,
      })
    );

    // If agent has a session ID, try to load history
    if (agent.sessionId) {
      try {
        const history = await SessionManager.getHistory(agent.sessionId, workingDir);
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebSocket connection handler with multiple event handlers
  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info('Chat WebSocket connection established', { sessionId, claudeSessionId });

    // Initialize session file logging
    sessionFileLogger.initSession(sessionId);
    sessionFileLogger.log(sessionId, 'INFO', {
      event: 'connection_established',
      sessionId,
      claudeSessionId,
      workingDir,
    });

    // Track this connection - close any existing connections for this session first
    // This handles React StrictMode double-mounting and stale connections
    const existingConnections = chatConnections.get(sessionId);
    if (existingConnections && existingConnections.size > 0) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Closing existing connections for session', {
          sessionId,
          count: existingConnections.size,
        });
      }
      sessionFileLogger.log(sessionId, 'INFO', {
        event: 'closing_existing_connections',
        count: existingConnections.size,
      });
      for (const existingWs of existingConnections) {
        existingWs.close(1000, 'New connection replacing old one');
      }
      existingConnections.clear();
    }

    if (!chatConnections.has(sessionId)) {
      chatConnections.set(sessionId, new Set());
    }
    const connections = chatConnections.get(sessionId);
    connections?.add(ws);

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Connection added', {
        sessionId,
        totalConnections: connections?.size ?? 0,
      });
    }

    // Get running status from chatClients
    const client = chatClients.get(sessionId);
    const isRunning = client?.isRunning() ?? false;
    const currentClaudeSessionId = client?.getSessionId() ?? claudeSessionId ?? null;

    // Send initial status
    const initialStatus = {
      type: 'status',
      sessionId,
      running: isRunning,
      claudeSessionId: currentClaudeSessionId,
    };
    sessionFileLogger.log(sessionId, 'OUT_TO_CLIENT', initialStatus);
    ws.send(JSON.stringify(initialStatus));

    // Handle incoming messages from client
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        // Log incoming message from client
        sessionFileLogger.log(sessionId, 'IN_FROM_CLIENT', message);
        await handleChatMessage(ws, sessionId, workingDir, message);
      } catch (error) {
        logger.error('Error handling chat message', error as Error);
        const errorResponse = { type: 'error', message: 'Invalid message format' };
        sessionFileLogger.log(sessionId, 'OUT_TO_CLIENT', errorResponse);
        ws.send(JSON.stringify(errorResponse));
      }
    });

    // Handle connection close
    ws.on('close', () => {
      logger.info('Chat WebSocket connection closed', { sessionId });
      sessionFileLogger.log(sessionId, 'INFO', { event: 'connection_closed' });
      sessionFileLogger.closeSession(sessionId);

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
      sessionFileLogger.log(sessionId, 'INFO', {
        event: 'connection_error',
        error: error.message,
      });
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

server.listen(PORT, async () => {
  logger.info('Backend server started', {
    port: PORT,
    environment: configService.getEnvironment(),
  });

  // Clean up orphan processes from previous crashes
  try {
    await agentProcessAdapter.cleanupOrphanProcesses();
  } catch (error) {
    logger.error('Failed to cleanup orphan processes on startup', error as Error);
  }

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
  // Clean up all chat clients
  for (const client of chatClients.values()) {
    client.kill();
  }
  chatClients.clear();
  // Clean up all agent processes
  agentProcessAdapter.cleanup();
  wss.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  // Clean up all chat clients
  for (const client of chatClients.values()) {
    client.kill();
  }
  chatClients.clear();
  // Clean up all agent processes
  agentProcessAdapter.cleanup();
  wss.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
});

// Handle uncaught exceptions - ensure process cleanup before crash
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception, cleaning up processes', error);
  // Synchronous cleanup of agent processes to prevent orphans
  agentProcessAdapter.cleanup();
  // Clean up chat clients
  for (const client of chatClients.values()) {
    client.kill();
  }
  chatClients.clear();
  // Exit with error code
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at promise', { reason, promise });
  // Log but don't exit - let the normal error handling deal with it
});
