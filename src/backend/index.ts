import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { WebSocketServer } from 'ws';
import { agentProcessAdapter } from './agents/process-adapter';
import { ClaudeClient, type ClaudeClientOptions, SessionManager } from './claude/index';
import { prisma } from './db';
import { claudeSessionAccessor } from './resource_accessors/claude-session.accessor';
import { terminalSessionAccessor } from './resource_accessors/terminal-session.accessor';
import { workspaceAccessor } from './resource_accessors/workspace.accessor';
import { projectRouter } from './routers/api/project.router';
import { executeMcpTool, initializeMcpTools } from './routers/mcp/index';
import {
  configService,
  createLogger,
  rateLimiter,
  reconciliationService,
  schedulerService,
} from './services/index';
import { terminalService } from './services/terminal.service';
import { appRouter, createContext } from './trpc/index';

const logger = createLogger('server');
const app = express();
const PORT = process.env.BACKEND_PORT || 3001;

// Create HTTP server and WebSocket server
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

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

/**
 * Connection info for a WebSocket connection.
 * Each browser window has a unique connectionId and views one dbSessionId at a time.
 */
interface ConnectionInfo {
  ws: import('ws').WebSocket;
  dbSessionId: string;
  workingDir: string;
}

/**
 * Pending message queued before Claude process is ready.
 */
interface PendingMessage {
  text: string;
  sentAt: Date;
}

// Track WebSocket connections by connectionId (unique per browser window)
// This allows multiple windows to view the same session
const chatConnections = new Map<string, ConnectionInfo>();

// Pending messages per dbSessionId (queued before Claude process is ready)
const pendingMessages = new Map<string, PendingMessage[]>();

// Maximum number of pending messages per session to prevent unbounded memory growth
const MAX_PENDING_MESSAGES = 100;

// ============================================================================
// Chat Client Manager
// ============================================================================

// Chat clients keyed by dbSessionId (always real database IDs, never temp IDs)
const chatClients = new Map<string, ClaudeClient>();
// Track pending client creation to prevent duplicate creation from race conditions
const pendingClientCreation = new Map<string, Promise<ClaudeClient>>();

// Debug logging for chat websocket (configurable via environment variable)
const DEBUG_CHAT_WS = process.env.DEBUG_CHAT_WS === 'true';
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
   * Initialize a log file for a session.
   * Returns early if already initialized to prevent duplicate log files.
   */
  initSession(sessionId: string): void {
    // Skip if already initialized (prevents duplicate log files when multiple windows connect)
    if (this.sessionLogs.has(sessionId)) {
      return;
    }

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
        ? '>>> OUT->CLIENT'
        : direction === 'IN_FROM_CLIENT'
          ? '<<< IN<-CLIENT'
          : direction === 'FROM_CLAUDE_CLI'
            ? '### FROM_CLI'
            : '*** INFO';

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

  /**
   * Close all active session logs (called during shutdown)
   */
  cleanup(): void {
    for (const sessionId of this.sessionLogs.keys()) {
      this.closeSession(sessionId);
    }
  }

  /**
   * Delete log files older than maxAgeDays (default 7 days)
   */
  cleanupOldLogs(maxAgeDays: number = 7): void {
    try {
      if (!existsSync(this.logDir)) {
        return;
      }

      const files = readdirSync(this.logDir);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      let deletedCount = 0;

      for (const file of files) {
        const filePath = join(this.logDir, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            unlinkSync(filePath);
            deletedCount++;
          }
        } catch {
          // Ignore individual file errors
        }
      }

      if (deletedCount > 0) {
        logger.info('[SessionFileLogger] Cleaned up old log files', { deletedCount, maxAgeDays });
      }
    } catch (error) {
      logger.error('[SessionFileLogger] Failed to cleanup old logs', { error });
    }
  }
}

// Global session file logger instance
const sessionFileLogger = new SessionFileLogger();

/**
 * Forward data to all WebSocket connections viewing a specific dbSessionId.
 * This broadcasts to all browser windows that have this session open.
 */
function forwardToConnections(dbSessionId: string, data: unknown): void {
  chatWsMsgCounter++;
  const msgNum = chatWsMsgCounter;

  // Find all connections viewing this session
  let connectionCount = 0;
  for (const info of chatConnections.values()) {
    if (info.dbSessionId === dbSessionId && info.ws.readyState === 1) {
      connectionCount++;
    }
  }

  if (connectionCount === 0) {
    if (DEBUG_CHAT_WS) {
      logger.debug(`[Chat WS #${msgNum}] No connections viewing session`, { dbSessionId });
    }
    return;
  }

  if (DEBUG_CHAT_WS) {
    const dataObj = data as { type?: string; data?: { type?: string; uuid?: string } };
    logger.info(`[Chat WS #${msgNum}] Sending to ${connectionCount} connection(s)`, {
      dbSessionId,
      type: dataObj.type,
      innerType: dataObj.data?.type,
      uuid: dataObj.data?.uuid,
    });
  }

  // Log to session file
  sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', data);

  const json = JSON.stringify(data);
  for (const info of chatConnections.values()) {
    if (info.dbSessionId === dbSessionId && info.ws.readyState === 1) {
      info.ws.send(json);
    }
  }
}

// Set up event forwarding from ClaudeClient to WebSocket connections
function setupChatClientEvents(dbSessionId: string, client: ClaudeClient): void {
  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Setting up event forwarding for session', { dbSessionId });
  }

  // Forward Claude CLI session ID to frontend when it becomes available
  // This is the actual Claude session ID used to store history in ~/.claude/projects/
  client.on('session_id', async (claudeSessionId) => {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Received session_id from Claude CLI', {
        dbSessionId,
        claudeSessionId,
      });
    }

    // Update database with Claude CLI session ID
    // This ensures the link persists even if user navigates away before frontend receives the message
    try {
      await claudeSessionAccessor.update(dbSessionId, { claudeSessionId });
      logger.info('[Chat WS] Updated database with claudeSessionId', {
        dbSessionId,
        claudeSessionId,
      });
    } catch (error) {
      logger.warn('[Chat WS] Failed to update database with claudeSessionId', {
        dbSessionId,
        claudeSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Drain pending messages now that Claude process is ready
    // Delete first to prevent re-entry if session_id fires multiple times
    const pending = pendingMessages.get(dbSessionId);
    pendingMessages.delete(dbSessionId);
    if (pending && pending.length > 0) {
      logger.info('[Chat WS] Draining pending messages', {
        dbSessionId,
        count: pending.length,
      });
      for (const msg of pending) {
        client.sendMessage(msg.text);
      }
    }

    forwardToConnections(dbSessionId, {
      type: 'status',
      running: true,
      claudeSessionId,
    });
  });

  // Forward stream events for real-time content (text deltas, tool_use blocks).
  // Note: We skip 'assistant' messages as they duplicate stream event content.
  // However, we DO forward 'user' messages that contain tool_result content,
  // as these are NOT duplicated by stream events and are needed for the UI
  // to show tool completion status.

  client.on('stream', (event) => {
    if (DEBUG_CHAT_WS) {
      const evt = event as { type?: string };
      logger.info('[Chat WS] Received stream event from client', {
        dbSessionId,
        eventType: evt.type,
      });
    }
    // Log the raw event from CLI before wrapping
    sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'stream', data: event });
    forwardToConnections(dbSessionId, { type: 'claude_message', data: event });
  });

  // Forward user messages that contain tool_result content.
  // This allows the frontend to pair tool_use with tool_result and show correct status.
  client.on('message', (msg) => {
    // Log ALL messages from CLI (even ones we don't forward)
    sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'message', data: msg });

    // Only forward user messages with tool_result content
    // Skip assistant messages as they duplicate stream events
    const msgWithType = msg as { type?: string; message?: { content?: Array<{ type?: string }> } };
    if (msgWithType.type !== 'user') {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'not_user_type',
        type: msgWithType.type,
      });
      return;
    }

    // Check if this user message contains tool_result
    const content = msgWithType.message?.content;
    if (!Array.isArray(content)) {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'no_array_content',
      });
      return;
    }

    const hasToolResult = content.some((item) => item.type === 'tool_result');
    if (!hasToolResult) {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'no_tool_result_content',
        content_types: content.map((c) => c.type),
      });
      return;
    }

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Forwarding user message with tool_result', { dbSessionId });
    }
    sessionFileLogger.log(dbSessionId, 'INFO', {
      action: 'forwarding_user_message_with_tool_result',
    });
    forwardToConnections(dbSessionId, { type: 'claude_message', data: msg });
  });

  // Forward result events to signal turn completion
  // This allows the frontend to know when Claude is done responding
  client.on('result', (result) => {
    if (DEBUG_CHAT_WS) {
      const res = result as { uuid?: string };
      logger.info('[Chat WS] Received result event from client', { dbSessionId, uuid: res.uuid });
    }
    // Log the raw result from CLI
    sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'result', data: result });
    forwardToConnections(dbSessionId, { type: 'claude_message', data: result });
  });

  client.on('exit', (result) => {
    forwardToConnections(dbSessionId, {
      type: 'process_exit',
      code: result.code,
      claudeSessionId: result.sessionId,
    });
    // Clean up all listeners to prevent memory leaks if client is recreated
    client.removeAllListeners();
    chatClients.delete(dbSessionId);
    // Clean up any remaining pending messages
    pendingMessages.delete(dbSessionId);
  });

  client.on('error', (error) => {
    forwardToConnections(dbSessionId, { type: 'error', message: error.message });
  });
}

// Get or create a chat client for a database session
async function getOrCreateChatClient(
  dbSessionId: string,
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
  let client = chatClients.get(dbSessionId);
  if (client?.isRunning()) {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Reusing existing running client', { dbSessionId });
    }
    return client;
  }

  // Check if there's already a pending creation for this session (race condition prevention)
  const pendingCreation = pendingClientCreation.get(dbSessionId);
  if (pendingCreation) {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Waiting for pending client creation', { dbSessionId });
    }
    return pendingCreation;
  }

  if (DEBUG_CHAT_WS) {
    logger.info('[Chat WS] Creating new client', {
      dbSessionId,
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

    try {
      const newClient = await ClaudeClient.create(clientOptions);

      // Set up event forwarding before storing in map to ensure events aren't missed
      setupChatClientEvents(dbSessionId, newClient);
      chatClients.set(dbSessionId, newClient);

      return newClient;
    } catch (error) {
      // Defensive cleanup - client may not be in map if create() failed before
      // chatClients.set() was reached, but ensures no partial state remains
      // if future code changes the order of operations
      chatClients.delete(dbSessionId);
      throw error;
    }
  })();

  pendingClientCreation.set(dbSessionId, createPromise);

  try {
    client = await createPromise;
    return client;
  } finally {
    pendingClientCreation.delete(dbSessionId);
  }
}

// Handle individual chat messages
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: handles multiple message types with settings
async function handleChatMessage(
  ws: import('ws').WebSocket,
  _connectionId: string,
  dbSessionId: string,
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
      // Notify client that session is starting (Claude CLI spinning up)
      ws.send(JSON.stringify({ type: 'starting', dbSessionId }));

      // Map planModeEnabled to permissionMode
      const permissionMode = message.planModeEnabled ? 'plan' : 'bypassPermissions';

      // Validate model value - only allow known models, fallback to default
      const validModels = ['sonnet', 'opus'];
      const requestedModel = message.selectedModel || message.model;
      const model =
        requestedModel && validModels.includes(requestedModel) ? requestedModel : undefined;

      // Look up resumeSessionId from database if not provided
      // This allows the frontend to not track claudeSessionId
      let resumeSessionId = message.resumeSessionId;
      if (!resumeSessionId) {
        const dbSession = await claudeSessionAccessor.findById(dbSessionId);
        resumeSessionId = dbSession?.claudeSessionId ?? undefined;
      }

      await getOrCreateChatClient(dbSessionId, {
        workingDir: message.workingDir || workingDir,
        resumeSessionId,
        systemPrompt: message.systemPrompt,
        model,
        thinkingEnabled: message.thinkingEnabled,
        permissionMode,
      });
      ws.send(JSON.stringify({ type: 'started', dbSessionId }));
      break;
    }

    case 'user_input': {
      const text = message.text || '';
      if (!text.trim()) {
        break;
      }

      const client = chatClients.get(dbSessionId);
      if (client?.isRunning()) {
        // Client is running, send message directly
        client.sendMessage(text);
      } else {
        // Client not running - queue message and start client
        // This handles the case where user sends before Claude is ready
        let queue = pendingMessages.get(dbSessionId);
        if (!queue) {
          queue = [];
          pendingMessages.set(dbSessionId, queue);
        }

        // Enforce maximum queue size to prevent unbounded memory growth
        if (queue.length >= MAX_PENDING_MESSAGES) {
          logger.warn('[Chat WS] Pending message queue full, rejecting message', {
            dbSessionId,
            queueLength: queue.length,
            maxSize: MAX_PENDING_MESSAGES,
          });
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Session is still starting. Please wait a moment and try again.',
            })
          );
          break;
        }

        queue.push({ text, sentAt: new Date() });

        logger.info('[Chat WS] Queued message for pending session', {
          dbSessionId,
          queueLength: queue.length,
        });

        // Send acknowledgment that message was queued
        ws.send(JSON.stringify({ type: 'message_queued', text }));

        // Notify client that session is starting (Claude CLI spinning up)
        ws.send(JSON.stringify({ type: 'starting', dbSessionId }));

        // Auto-start if not running
        await getOrCreateChatClient(dbSessionId, { workingDir });
        ws.send(JSON.stringify({ type: 'started', dbSessionId }));
        // Note: The queued message will be sent when 'session_id' event fires
      }
      break;
    }

    case 'stop': {
      const client = chatClients.get(dbSessionId);
      if (client) {
        client.kill();
        chatClients.delete(dbSessionId);
      }
      // Clean up pending messages
      pendingMessages.delete(dbSessionId);
      ws.send(JSON.stringify({ type: 'stopped', dbSessionId }));
      break;
    }

    case 'get_history': {
      const client = chatClients.get(dbSessionId);
      const claudeSessionId = client?.getSessionId();
      if (claudeSessionId) {
        const history = await SessionManager.getHistory(claudeSessionId, workingDir);
        ws.send(JSON.stringify({ type: 'history', dbSessionId, messages: history }));
      } else {
        ws.send(JSON.stringify({ type: 'history', dbSessionId, messages: [] }));
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
      // Settings are inferred from session file (model from assistant messages,
      // thinking mode from last user message ending with suffix)

      // claudeSessionId can come from the message, or we look it up from the database
      let targetSessionId: string | null | undefined = message.claudeSessionId;
      let sessionNotFound = false;

      if (!targetSessionId) {
        // Look up claudeSessionId from the database using dbSessionId
        const dbSession = await claudeSessionAccessor.findById(dbSessionId);
        if (dbSession) {
          targetSessionId = dbSession.claudeSessionId ?? null;
        } else {
          // Session doesn't exist in database
          sessionNotFound = true;
        }
      }

      if (sessionNotFound) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
        break;
      }

      if (targetSessionId) {
        const [history, model, thinkingEnabled, gitBranch] = await Promise.all([
          SessionManager.getHistory(targetSessionId, workingDir),
          SessionManager.getSessionModel(targetSessionId, workingDir),
          SessionManager.getSessionThinkingEnabled(targetSessionId, workingDir),
          SessionManager.getSessionGitBranch(targetSessionId, workingDir),
        ]);

        // Map full model ID to short alias if needed
        const selectedModel = model?.includes('opus')
          ? 'opus'
          : model?.includes('haiku')
            ? 'haiku'
            : null; // null = sonnet (default)

        ws.send(
          JSON.stringify({
            type: 'session_loaded',
            claudeSessionId: targetSessionId,
            messages: history,
            gitBranch,
            settings: {
              selectedModel,
              thinkingEnabled,
              planModeEnabled: false, // Plan mode is not persisted, always default to off
            },
          })
        );
      } else {
        // No claudeSessionId available - this is a new session with no history
        // Send an empty session_loaded response so the UI knows loading is complete
        ws.send(
          JSON.stringify({
            type: 'session_loaded',
            claudeSessionId: null,
            messages: [],
            gitBranch: null,
            settings: {
              selectedModel: null,
              thinkingEnabled: false,
              planModeEnabled: false,
            },
          })
        );
      }
      break;
    }
  }
}

/**
 * Validate that workingDir is safe and within the worktree base directory.
 * Resolves symlinks to prevent escaping the allowed directory via symlink traversal.
 * Returns resolved path if valid, or null if invalid.
 */
function validateWorkingDir(workingDir: string): string | null {
  // Reject paths with path traversal attempts
  if (workingDir.includes('..')) {
    return null;
  }

  // Must be an absolute path
  if (!workingDir.startsWith('/')) {
    return null;
  }

  // Resolve the path to normalize it (removes double slashes, etc.)
  const normalized = resolve(workingDir);

  // The path must exist to resolve symlinks
  if (!existsSync(normalized)) {
    return null;
  }

  // Resolve symlinks to get the real path - this prevents symlink-based escapes
  let realPath: string;
  try {
    realPath = realpathSync(normalized);
  } catch {
    // realpathSync can fail if path becomes invalid during resolution
    return null;
  }

  // Ensure the real path (with symlinks resolved) is within the worktree base directory
  // Also resolve symlinks in worktreeBaseDir to handle cases where the base dir itself contains symlinks
  let worktreeBaseDir: string;
  try {
    worktreeBaseDir = realpathSync(configService.getWorktreeBaseDir());
  } catch {
    // If worktree base dir doesn't exist or can't be resolved, reject all paths
    return null;
  }
  if (!realPath.startsWith(`${worktreeBaseDir}/`) && realPath !== worktreeBaseDir) {
    return null;
  }

  return realPath;
}

// Handle chat WebSocket upgrade
function handleChatUpgrade(
  request: import('http').IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
  url: URL
) {
  // connectionId: unique per browser window, used for routing messages
  const connectionId = url.searchParams.get('connectionId') || `conn-${Date.now()}`;
  // dbSessionId: database session ID, required for linking to Claude process
  const dbSessionId = url.searchParams.get('sessionId');
  const rawWorkingDir = url.searchParams.get('workingDir');
  const claudeSessionId = url.searchParams.get('claudeSessionId');

  // Require dbSessionId parameter - no temp IDs allowed
  if (!dbSessionId) {
    logger.warn('Missing sessionId (dbSessionId) parameter', { connectionId });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId parameter');
    socket.destroy();
    return;
  }

  // Require workingDir parameter - no fallback to process.cwd()
  if (!rawWorkingDir) {
    logger.warn('Missing workingDir parameter', { dbSessionId, connectionId });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing workingDir parameter');
    socket.destroy();
    return;
  }

  // Validate workingDir to prevent path traversal
  const workingDir = validateWorkingDir(rawWorkingDir);
  if (!workingDir) {
    logger.warn('Invalid workingDir rejected', { rawWorkingDir, dbSessionId, connectionId });
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid workingDir');
    socket.destroy();
    return;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebSocket connection handler with multiple event handlers
  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info('Chat WebSocket connection established', {
      connectionId,
      dbSessionId,
      claudeSessionId,
    });

    // Setup heartbeat tracking
    wsAliveMap.set(ws, true);
    ws.on('pong', () => wsAliveMap.set(ws, true));

    // Initialize session file logging
    sessionFileLogger.initSession(dbSessionId);
    sessionFileLogger.log(dbSessionId, 'INFO', {
      event: 'connection_established',
      connectionId,
      dbSessionId,
      claudeSessionId,
      workingDir,
    });

    // Close any existing connection with the same connectionId (handles React StrictMode)
    const existingConnection = chatConnections.get(connectionId);
    if (existingConnection) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Closing existing connection', {
          connectionId,
          oldDbSessionId: existingConnection.dbSessionId,
        });
      }
      existingConnection.ws.close(1000, 'New connection replacing old one');
    }

    // Register this connection
    chatConnections.set(connectionId, {
      ws,
      dbSessionId,
      workingDir,
    });

    if (DEBUG_CHAT_WS) {
      // Count connections viewing this session
      let viewingCount = 0;
      for (const info of chatConnections.values()) {
        if (info.dbSessionId === dbSessionId) {
          viewingCount++;
        }
      }
      logger.info('[Chat WS] Connection registered', {
        connectionId,
        dbSessionId,
        totalConnectionsViewingSession: viewingCount,
      });
    }

    // Get running status from chatClients
    const client = chatClients.get(dbSessionId);
    const isRunning = client?.isRunning() ?? false;
    const currentClaudeSessionId = client?.getSessionId() ?? claudeSessionId ?? null;

    // Send initial status
    const initialStatus = {
      type: 'status',
      dbSessionId,
      running: isRunning,
      claudeSessionId: currentClaudeSessionId,
    };
    sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', initialStatus);
    ws.send(JSON.stringify(initialStatus));

    // Handle incoming messages from client
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        // Log incoming message from client
        sessionFileLogger.log(dbSessionId, 'IN_FROM_CLIENT', message);
        await handleChatMessage(ws, connectionId, dbSessionId, workingDir, message);
      } catch (error) {
        logger.error('Error handling chat message', error as Error);
        const errorResponse = { type: 'error', message: 'Invalid message format' };
        sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', errorResponse);
        ws.send(JSON.stringify(errorResponse));
      }
    });

    // Handle connection close
    ws.on('close', () => {
      logger.info('Chat WebSocket connection closed', { connectionId, dbSessionId });
      sessionFileLogger.log(dbSessionId, 'INFO', { event: 'connection_closed', connectionId });
      sessionFileLogger.closeSession(dbSessionId);

      // Remove this connection
      chatConnections.delete(connectionId);
    });

    // Handle connection errors
    ws.on('error', (error) => {
      logger.error('Chat WebSocket error', error);
      sessionFileLogger.log(dbSessionId, 'INFO', {
        event: 'connection_error',
        connectionId,
        error: error.message,
      });
    });
  });
}

// ============================================================================
// Terminal WebSocket Handler
// ============================================================================

// Track terminal WebSocket connections per workspace
const terminalConnections = new Map<string, Set<import('ws').WebSocket>>();

// Track listener unsubscribe functions per WebSocket connection
// Map: WebSocket -> Map<terminalId, unsubscribe functions[]>
const terminalListenerCleanup = new WeakMap<import('ws').WebSocket, Map<string, (() => void)[]>>();

// Track terminal grace periods to allow reconnection
const TERMINAL_GRACE_PERIOD_MS = 30_000;
const terminalGracePeriods = new Map<string, NodeJS.Timeout>();

/**
 * Clean up all terminal listener subscriptions for a WebSocket connection
 */
function cleanupTerminalListeners(ws: import('ws').WebSocket): void {
  const cleanupMap = terminalListenerCleanup.get(ws);
  if (!cleanupMap) {
    return;
  }

  for (const [terminalId, unsubs] of cleanupMap) {
    logger.debug('Cleaning up listeners for terminal', { terminalId });
    for (const unsub of unsubs) {
      unsub();
    }
  }
  cleanupMap.clear();
}

// Handle terminal WebSocket upgrade
function handleTerminalUpgrade(
  request: import('http').IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
  url: URL
) {
  const workspaceId = url.searchParams.get('workspaceId');

  if (!workspaceId) {
    logger.warn('Terminal WebSocket missing workspaceId');
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Terminal WebSocket handler requires handling multiple connection states, message types, and cleanup scenarios
  wss.handleUpgrade(request, socket, head, (ws) => {
    logger.info('Terminal WebSocket connection established', { workspaceId });

    // Setup heartbeat tracking
    wsAliveMap.set(ws, true);
    ws.on('pong', () => wsAliveMap.set(ws, true));

    // Cancel any pending grace period cleanup for this workspace
    const existingGracePeriod = terminalGracePeriods.get(workspaceId);
    if (existingGracePeriod) {
      clearTimeout(existingGracePeriod);
      terminalGracePeriods.delete(workspaceId);
      logger.info('Cancelled terminal grace period due to reconnection', { workspaceId });
    }

    // Track connection
    if (!terminalConnections.has(workspaceId)) {
      terminalConnections.set(workspaceId, new Set());
    }
    terminalConnections.get(workspaceId)?.add(ws);

    // Initialize listener cleanup tracking for this WebSocket
    terminalListenerCleanup.set(ws, new Map());

    // Send initial status
    logger.debug('Sending initial status message', { workspaceId });
    ws.send(JSON.stringify({ type: 'status', connected: true }));

    // Send list of existing terminals for this workspace (for restoration after page refresh)
    const existingTerminals = terminalService.getTerminalsForWorkspace(workspaceId);
    if (existingTerminals.length > 0) {
      logger.info('Sending existing terminal list for restoration', {
        workspaceId,
        terminalCount: existingTerminals.length,
      });

      // Send the terminal list to the client (including buffered output for restoration)
      ws.send(
        JSON.stringify({
          type: 'terminal_list',
          terminals: existingTerminals.map((t) => ({
            id: t.id,
            createdAt: t.createdAt.toISOString(),
            outputBuffer: t.outputBuffer,
          })),
        })
      );

      // Clean up listeners from any existing WebSocket connections to prevent duplicates
      // This handles the case where a client reconnects before the old connection fully closes
      const existingConnections = terminalConnections.get(workspaceId);
      if (existingConnections) {
        for (const existingWs of existingConnections) {
          if (existingWs !== ws) {
            logger.debug('Cleaning up listeners from existing connection', { workspaceId });
            cleanupTerminalListeners(existingWs);
          }
        }
      }

      // Set up output/exit listeners for each existing terminal
      const cleanupMap = terminalListenerCleanup.get(ws);
      for (const terminal of existingTerminals) {
        const unsubscribers: (() => void)[] = [];
        if (cleanupMap) {
          cleanupMap.set(terminal.id, unsubscribers);
        }

        // Set up output forwarding
        const unsubOutput = terminalService.onOutput(terminal.id, (output) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'output', terminalId: terminal.id, data: output }));
          }
        });
        unsubscribers.push(unsubOutput);

        // Set up exit handler
        const unsubExit = terminalService.onExit(terminal.id, (exitCode) => {
          logger.info('Terminal process exited', { terminalId: terminal.id, exitCode });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'exit', terminalId: terminal.id, exitCode }));
          }
          const exitCleanupMap = terminalListenerCleanup.get(ws);
          if (exitCleanupMap) {
            exitCleanupMap.delete(terminal.id);
          }
          // Clear PID in database since process is no longer running
          terminalSessionAccessor.clearPid(terminal.id).catch((err) => {
            logger.warn('Failed to clear terminal PID', { terminalId: terminal.id, error: err });
          });
        });
        unsubscribers.push(unsubExit);
      }
    }

    // Handle messages
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebSocket handler needs to handle multiple message types
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        logger.debug('Received terminal message', {
          workspaceId,
          type: message.type,
          terminalId: message.terminalId,
        });

        switch (message.type) {
          case 'create': {
            logger.info('Creating terminal', {
              workspaceId,
              cols: message.cols,
              rows: message.rows,
            });
            // Get workspace to find working directory
            const workspace = await workspaceAccessor.findById(workspaceId);
            if (!workspace?.worktreePath) {
              logger.warn('Workspace not found or has no worktree', { workspaceId });
              ws.send(
                JSON.stringify({ type: 'error', message: 'Workspace not found or has no worktree' })
              );
              return;
            }

            logger.info('Creating terminal with worktree', {
              workspaceId,
              worktreePath: workspace.worktreePath,
            });
            const { terminalId, pid } = await terminalService.createTerminal({
              workspaceId,
              workingDir: workspace.worktreePath,
              cols: message.cols ?? 80,
              rows: message.rows ?? 24,
            });

            // Persist the terminal session with PID for orphan process detection
            await terminalSessionAccessor.create({
              workspaceId,
              name: terminalId,
              pid,
            });

            // Initialize cleanup map entry BEFORE registering listeners to prevent race condition
            // If WebSocket closes between listener registration and map storage, listeners would leak
            const cleanupMap = terminalListenerCleanup.get(ws);
            const unsubscribers: (() => void)[] = [];
            if (cleanupMap) {
              cleanupMap.set(terminalId, unsubscribers);
            }

            // Set up output forwarding - include terminalId so frontend can route to correct tab
            logger.debug('Setting up output forwarding', { terminalId });
            const unsubOutput = terminalService.onOutput(terminalId, (output) => {
              if (ws.readyState === 1) {
                logger.debug('Forwarding output to client', {
                  terminalId,
                  outputLen: output.length,
                });
                ws.send(JSON.stringify({ type: 'output', terminalId, data: output }));
              } else {
                logger.warn('Cannot forward output - WebSocket not open', {
                  terminalId,
                  readyState: ws.readyState,
                });
              }
            });
            unsubscribers.push(unsubOutput);

            // Set up exit handler - include terminalId so frontend can route to correct tab
            const unsubExit = terminalService.onExit(terminalId, (exitCode) => {
              logger.info('Terminal process exited', { terminalId, exitCode });
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'exit', terminalId, exitCode }));
              }
              // Clean up listeners for this terminal when it exits
              const exitCleanupMap = terminalListenerCleanup.get(ws);
              if (exitCleanupMap) {
                exitCleanupMap.delete(terminalId);
              }
              // Clear PID in database since process is no longer running
              terminalSessionAccessor.clearPid(terminalId).catch((err) => {
                logger.warn('Failed to clear terminal PID', { terminalId, error: err });
              });
            });
            unsubscribers.push(unsubExit);

            logger.info('Sending created message to client', { terminalId });
            ws.send(JSON.stringify({ type: 'created', terminalId }));
            break;
          }

          case 'input': {
            if (message.terminalId && message.data) {
              logger.debug('Writing input to terminal', {
                terminalId: message.terminalId,
                dataLen: message.data.length,
              });
              const success = terminalService.writeToTerminal(
                workspaceId,
                message.terminalId,
                message.data
              );
              if (!success) {
                logger.warn('Failed to write to terminal', {
                  workspaceId,
                  terminalId: message.terminalId,
                });
              }
            } else {
              logger.warn('Input message missing terminalId or data', { message });
            }
            break;
          }

          case 'resize': {
            if (message.terminalId && message.cols && message.rows) {
              logger.debug('Resizing terminal', {
                terminalId: message.terminalId,
                cols: message.cols,
                rows: message.rows,
              });
              terminalService.resizeTerminal(
                workspaceId,
                message.terminalId,
                message.cols,
                message.rows
              );
            } else {
              logger.warn('Resize message missing required fields', { message });
            }
            break;
          }

          case 'destroy': {
            if (message.terminalId) {
              logger.info('Destroying terminal', { terminalId: message.terminalId });
              // Clean up listeners before destroying
              const cleanupMap = terminalListenerCleanup.get(ws);
              const unsubs = cleanupMap?.get(message.terminalId);
              if (unsubs) {
                for (const unsub of unsubs) {
                  unsub();
                }
                cleanupMap?.delete(message.terminalId);
              }
              terminalService.destroyTerminal(workspaceId, message.terminalId);
            }
            break;
          }

          default:
            logger.warn('Unknown message type', { type: message.type });
        }
      } catch (error) {
        const err = error as Error;
        // Determine if this is a parse error or an operation error
        const isParsError = err instanceof SyntaxError;
        const errorMessage = isParsError
          ? 'Invalid message format'
          : `Operation failed: ${err.message}`;

        logger.error('Error handling terminal message', err, {
          workspaceId,
          isParsError,
        });

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: errorMessage }));
        }
      }
    });

    // Handle close
    ws.on('close', () => {
      logger.info('Terminal WebSocket connection closed', { workspaceId });

      // Clean up all listener subscriptions for this WebSocket
      cleanupTerminalListeners(ws);

      const connections = terminalConnections.get(workspaceId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          terminalConnections.delete(workspaceId);
          // Instead of immediately destroying terminals, allow a grace period for reconnection
          logger.info('Starting terminal grace period', {
            workspaceId,
            gracePeriodMs: TERMINAL_GRACE_PERIOD_MS,
          });
          const gracePeriodTimeout = setTimeout(() => {
            // Only destroy if no new connections have been established
            if (!terminalConnections.has(workspaceId)) {
              logger.info('Grace period expired, destroying workspace terminals', { workspaceId });
              terminalService.destroyWorkspaceTerminals(workspaceId);
            }
            terminalGracePeriods.delete(workspaceId);
          }, TERMINAL_GRACE_PERIOD_MS);
          terminalGracePeriods.set(workspaceId, gracePeriodTimeout);
        }
      }
    });

    // Handle errors
    ws.on('error', (error) => {
      logger.error('Terminal WebSocket error', error);
    });
  });
}

// ============================================================================
// WebSocket Upgrade Handler
// ============================================================================

// Handle WebSocket upgrade requests
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);

  // Route to appropriate handler based on path
  if (url.pathname === '/chat') {
    handleChatUpgrade(request, socket, head, url);
    return;
  }

  if (url.pathname === '/terminal') {
    handleTerminalUpgrade(request, socket, head, url);
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

  // Clean up orphan sessions from previous crashes
  try {
    await reconciliationService.cleanupOrphans();
  } catch (error) {
    logger.error('Failed to cleanup orphan sessions on startup', error as Error);
  }

  // Clean up old log files (older than 7 days)
  sessionFileLogger.cleanupOldLogs();

  // Start periodic orphan cleanup
  reconciliationService.startPeriodicCleanup();

  // Start background scheduler (PR sync, etc.)
  schedulerService.start();

  logger.info('Server endpoints available', {
    server: `http://localhost:${PORT}`,
    health: `http://localhost:${PORT}/health`,
    healthAll: `http://localhost:${PORT}/health/all`,
    trpc: `http://localhost:${PORT}/api/trpc`,
    wsChat: `ws://localhost:${PORT}/chat`,
    wsTerminal: `ws://localhost:${PORT}/terminal`,
  });
});

// Shared cleanup logic
const SHUTDOWN_TIMEOUT_MS = 5000;

const performCleanup = async () => {
  logger.info('Starting graceful cleanup');

  // Stop heartbeat interval
  clearInterval(heartbeatInterval);

  // Cancel all terminal grace periods
  for (const [workspaceId, timeout] of terminalGracePeriods) {
    clearTimeout(timeout);
    logger.debug('Cancelled terminal grace period during shutdown', { workspaceId });
  }
  terminalGracePeriods.clear();

  // Stop accepting new connections
  wss.close();
  server.close();

  // Gracefully stop all chat clients with timeout
  const stopPromises: Promise<void>[] = [];
  for (const [sessionId, client] of chatClients) {
    let didTimeout = false;
    const stopPromise = Promise.race([
      (async () => {
        try {
          await client.stop();
        } catch {
          client.kill();
        }
      })(),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          didTimeout = true;
          resolve();
        }, SHUTDOWN_TIMEOUT_MS)
      ),
    ]).then(() => {
      if (didTimeout) {
        logger.warn('Client stop timed out, force killing', { sessionId });
      }
      // Ensure kill is called as a final measure
      try {
        client.kill();
      } catch {
        // Ignore kill errors
      }
    });
    stopPromises.push(stopPromise);
    logger.debug('Stopping chat client', { sessionId });
  }

  // Wait for all clients to stop (or timeout)
  await Promise.all(stopPromises);

  // Explicitly remove all listeners from clients in case exit events didn't fire
  // (e.g., timeout reached, client already dead, or kill() failed to emit exit)
  for (const client of chatClients.values()) {
    client.removeAllListeners();
  }
  chatClients.clear();

  // Clean up all terminals (disposes listeners before killing)
  terminalService.cleanup();

  // Clean up all agent processes
  agentProcessAdapter.cleanup();

  // Clean up session file logger
  sessionFileLogger.cleanup();

  // Stop background scheduler (waits for any in-flight tasks)
  await schedulerService.stop();

  // Stop periodic orphan cleanup (waits for any in-flight cleanup)
  await reconciliationService.stopPeriodicCleanup();

  // Disconnect from database
  await prisma.$disconnect();

  logger.info('Graceful cleanup completed');
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await performCleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await performCleanup();
  process.exit(0);
});

// Handle uncaught exceptions - ensure process cleanup before crash
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception, cleaning up processes', error);
  // Synchronous cleanup
  clearInterval(heartbeatInterval);
  // Cancel all terminal grace periods
  for (const timeout of terminalGracePeriods.values()) {
    clearTimeout(timeout);
  }
  terminalGracePeriods.clear();
  // Synchronous cleanup of agent processes to prevent orphans
  agentProcessAdapter.cleanup();
  // Clean up chat clients - remove listeners before kill to prevent any callbacks
  for (const client of chatClients.values()) {
    client.removeAllListeners();
    client.kill();
  }
  chatClients.clear();
  // Clean up all terminals
  terminalService.cleanup();
  // Clean up session file logger
  sessionFileLogger.cleanup();
  // Exit with error code
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at promise', { reason, promise });
  // Log but don't exit - let the normal error handling deal with it
});
