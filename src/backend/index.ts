import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { serve } from 'inngest/express';
import { WebSocketServer } from 'ws';
import { agentProcessAdapter } from './agents/process-adapter';
import { ClaudeClient, type ClaudeClientOptions, SessionManager } from './claude/index';
import { prisma } from './db';
import { inngest } from './inngest/client';
import { workspaceAccessor } from './resource_accessors/workspace.accessor';
import { projectRouter } from './routers/api/project.router';
import { executeMcpTool, initializeMcpTools } from './routers/mcp/index';
import { configService, createLogger, rateLimiter, reconciliationService } from './services/index';
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

// Inngest webhook handler (empty functions array for now)
app.use(
  '/api/inngest',
  serve({
    client: inngest,
    functions: [],
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
    // Clean up all listeners to prevent memory leaks if client is recreated
    client.removeAllListeners();
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

    try {
      const newClient = await ClaudeClient.create(clientOptions);

      // Set up event forwarding before storing in map to ensure events aren't missed
      setupChatClientEvents(sessionId, newClient);
      chatClients.set(sessionId, newClient);

      return newClient;
    } catch (error) {
      // Defensive cleanup - client may not be in map if create() failed before
      // chatClients.set() was reached, but ensures no partial state remains
      // if future code changes the order of operations
      chatClients.delete(sessionId);
      throw error;
    }
  })();

  pendingClientCreation.set(sessionId, createPromise);

  try {
    client = await createPromise;
    return client;
  } finally {
    pendingClientCreation.delete(sessionId);
  }
}

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
      // Notify client that session is starting (Claude CLI spinning up)
      ws.send(JSON.stringify({ type: 'starting', sessionId }));

      // Map planModeEnabled to permissionMode
      const permissionMode = message.planModeEnabled ? 'plan' : 'bypassPermissions';

      // Validate model value - only allow known models, fallback to default
      const validModels = ['sonnet', 'opus'];
      const requestedModel = message.selectedModel || message.model;
      const model =
        requestedModel && validModels.includes(requestedModel) ? requestedModel : undefined;

      await getOrCreateChatClient(sessionId, {
        workingDir: message.workingDir || workingDir,
        resumeSessionId: message.resumeSessionId,
        systemPrompt: message.systemPrompt,
        model,
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
        // Notify client that session is starting (Claude CLI spinning up)
        ws.send(JSON.stringify({ type: 'starting', sessionId }));
        // Auto-start if not running
        const newClient = await getOrCreateChatClient(sessionId, { workingDir });
        ws.send(JSON.stringify({ type: 'started', sessionId }));
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
      // Settings are inferred from session file (model from assistant messages,
      // thinking mode from last user message ending with suffix)
      const targetSessionId = message.claudeSessionId;
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

    // Setup heartbeat tracking
    wsAliveMap.set(ws, true);
    ws.on('pong', () => wsAliveMap.set(ws, true));

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
            const terminalId = await terminalService.createTerminal({
              workspaceId,
              workingDir: workspace.worktreePath,
              cols: message.cols ?? 80,
              rows: message.rows ?? 24,
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

  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Health check (all): http://localhost:${PORT}/health/all`);
  console.log(`Inngest endpoint: http://localhost:${PORT}/api/inngest`);
  console.log(`tRPC endpoint: http://localhost:${PORT}/api/trpc`);
  console.log(`WebSocket chat: ws://localhost:${PORT}/chat`);
  console.log(`WebSocket terminal: ws://localhost:${PORT}/terminal`);
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
