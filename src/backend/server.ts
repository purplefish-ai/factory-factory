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
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import express from 'express';
import { WebSocketServer } from 'ws';
import { agentProcessAdapter } from './agents/process-adapter';
import { ClaudeClient, type ClaudeClientOptions, SessionManager } from './claude/index';
import { prisma } from './db';
import { interceptorRegistry, registerInterceptors } from './interceptors';
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
  sessionService,
} from './services/index';
import { terminalService } from './services/terminal.service';
import { appRouter, createContext } from './trpc/index';

const logger = createLogger('server');

/**
 * Server instance returned by createServer()
 */
export interface ServerInstance {
  /** Start the server and return the URL */
  start(): Promise<string>;
  /** Stop the server gracefully */
  stop(): Promise<void>;
  /** Get the actual port the server is listening on */
  getPort(): number;
  /** Get the HTTP server instance (for Electron to monitor) */
  getHttpServer(): HttpServer;
}

/**
 * Check if a port is available by attempting to create a server on it.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createNetServer();
    testServer.once('error', () => {
      resolve(false);
    });
    testServer.once('listening', () => {
      testServer.close(() => resolve(true));
    });
    testServer.listen(port, 'localhost');
  });
}

/**
 * Find an available port starting from the given port.
 */
async function findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find an available port starting from ${startPort}`);
}

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
    // Use WS_LOGS_PATH env var (set by Electron), or fall back to .context/ws-logs in cwd
    // For Electron, this will be in userData directory
    const basePath = process.env.WS_LOGS_PATH || join(process.cwd(), '.context', 'ws-logs');
    this.logDir = basePath;
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

/**
 * Create and configure the backend server.
 * Environment variables must be set before calling this function.
 *
 * @param requestedPort - Port to listen on (default: from BACKEND_PORT env or 3001)
 * @returns ServerInstance with start/stop methods
 */
export function createServer(requestedPort?: number): ServerInstance {
  const REQUESTED_PORT = requestedPort ?? Number.parseInt(process.env.BACKEND_PORT || '3001', 10);
  let actualPort: number = REQUESTED_PORT;

  const app = express();

  // Create HTTP server and WebSocket server
  const server = createHttpServer(app);
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
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-XSS-Protection', '1; mode=block');
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

  // Register tool interceptors
  registerInterceptors();

  // ============================================================================
  // Health Check Endpoints
  // ============================================================================

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'factoryfactory-backend',
      version: process.env.npm_package_version || '0.1.0',
      environment: configService.getEnvironment(),
    });
  });

  app.get('/health/database', async (_req, res) => {
    try {
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

  app.get('/health/all', async (_req, res) => {
    const checks: Record<string, { status: string; details?: unknown }> = {};

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'ok' };
    } catch (error) {
      checks.database = {
        status: 'error',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    const apiUsage = rateLimiter.getApiUsageStats();
    checks.rateLimiter = {
      status: apiUsage.isRateLimited ? 'degraded' : 'ok',
      details: {
        requestsLastMinute: apiUsage.requestsLastMinute,
        isRateLimited: apiUsage.isRateLimited,
      },
    };

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

      if (!agentId) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Missing required field: agentId' },
        });
      }

      if (!toolName) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Missing required field: toolName' },
        });
      }

      const result = await executeMcpTool(agentId, toolName, input || {});
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

  app.use('/api/projects', projectRouter);

  app.use(
    '/api/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // ============================================================================
  // Static File Serving (Production Mode)
  // ============================================================================

  const frontendStaticPath = process.env.FRONTEND_STATIC_PATH;
  if (frontendStaticPath && existsSync(frontendStaticPath)) {
    logger.info('Serving static files from', { path: frontendStaticPath });

    app.use(
      express.static(frontendStaticPath, {
        maxAge: '1d',
        etag: true,
      })
    );

    app.get('/{*splat}', (req, res, next) => {
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/mcp') ||
        req.path.startsWith('/health') ||
        req.path === '/chat' ||
        req.path === '/terminal'
      ) {
        return next();
      }
      res.sendFile(join(frontendStaticPath, 'index.html'));
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
  // WebSocket Chat Handler (Claude CLI JSON Streaming)
  // ============================================================================

  interface ConnectionInfo {
    ws: import('ws').WebSocket;
    dbSessionId: string;
    workingDir: string;
  }

  interface PendingMessage {
    text: string;
    sentAt: Date;
  }

  const chatConnections = new Map<string, ConnectionInfo>();
  const pendingMessages = new Map<string, PendingMessage[]>();
  const MAX_PENDING_MESSAGES = 100;

  // Chat clients keyed by dbSessionId
  const chatClients = new Map<string, ClaudeClient>();
  const pendingClientCreation = new Map<string, Promise<ClaudeClient>>();

  const DEBUG_CHAT_WS = process.env.DEBUG_CHAT_WS === 'true';
  let chatWsMsgCounter = 0;

  const sessionFileLogger = new SessionFileLogger();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: WebSocket forwarding with debug logging
  function forwardToConnections(dbSessionId: string, data: unknown): void {
    chatWsMsgCounter++;
    const msgNum = chatWsMsgCounter;

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

    sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', data);

    const json = JSON.stringify(data);
    for (const info of chatConnections.values()) {
      if (info.dbSessionId === dbSessionId && info.ws.readyState === 1) {
        info.ws.send(json);
      }
    }
  }

  function notifyToolResultInterceptors(
    content: Array<{ type?: string }>,
    pendingToolNames: Map<string, string>,
    pendingToolInputs: Map<string, Record<string, unknown>>,
    interceptorContext: { sessionId: string; workspaceId: string; workingDir: string }
  ): void {
    for (const item of content) {
      const typedItem = item as {
        type: string;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      };
      if (typedItem.type !== 'tool_result' || !typedItem.tool_use_id) {
        continue;
      }

      const toolName = pendingToolNames.get(typedItem.tool_use_id) ?? 'unknown';
      const toolInput = pendingToolInputs.get(typedItem.tool_use_id) ?? {};

      interceptorRegistry.notifyToolComplete(
        {
          toolUseId: typedItem.tool_use_id,
          toolName,
          input: toolInput,
          output: {
            content:
              typeof typedItem.content === 'string'
                ? typedItem.content
                : JSON.stringify(typedItem.content),
            isError: typedItem.is_error ?? false,
          },
        },
        { ...interceptorContext, timestamp: new Date() }
      );

      pendingToolNames.delete(typedItem.tool_use_id);
      pendingToolInputs.delete(typedItem.tool_use_id);
    }
  }

  function setupChatClientEvents(
    dbSessionId: string,
    client: ClaudeClient,
    context: { workspaceId: string; workingDir: string }
  ): void {
    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Setting up event forwarding for session', { dbSessionId });
    }

    const pendingToolNames = new Map<string, string>();
    const pendingToolInputs = new Map<string, Record<string, unknown>>();

    client.on('tool_use', (toolUse) => {
      pendingToolNames.set(toolUse.id, toolUse.name);
      pendingToolInputs.set(toolUse.id, toolUse.input);

      interceptorRegistry.notifyToolStart(
        { toolUseId: toolUse.id, toolName: toolUse.name, input: toolUse.input },
        {
          sessionId: dbSessionId,
          workspaceId: context.workspaceId,
          workingDir: context.workingDir,
          timestamp: new Date(),
        }
      );
    });

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: session initialization with error handling
    client.on('session_id', async (claudeSessionId) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received session_id from Claude CLI', {
          dbSessionId,
          claudeSessionId,
        });
      }

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

      const pending = pendingMessages.get(dbSessionId);
      pendingMessages.delete(dbSessionId);
      if (pending && pending.length > 0) {
        logger.info('[Chat WS] Draining pending messages on session_id', {
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
      });
    });

    client.on('stream', (event) => {
      if (DEBUG_CHAT_WS) {
        const evt = event as { type?: string };
        logger.info('[Chat WS] Received stream event from client', {
          dbSessionId,
          eventType: evt.type,
        });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'stream', data: event });
      forwardToConnections(dbSessionId, { type: 'claude_message', data: event });
    });

    client.on('message', (msg) => {
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'message', data: msg });

      const msgWithType = msg as {
        type?: string;
        message?: { content?: Array<{ type?: string }> };
      };
      if (msgWithType.type !== 'user') {
        sessionFileLogger.log(dbSessionId, 'INFO', {
          action: 'skipped_message',
          reason: 'not_user_type',
          type: msgWithType.type,
        });
        return;
      }

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

      notifyToolResultInterceptors(content, pendingToolNames, pendingToolInputs, {
        sessionId: dbSessionId,
        workspaceId: context.workspaceId,
        workingDir: context.workingDir,
      });

      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Forwarding user message with tool_result', { dbSessionId });
      }
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'forwarding_user_message_with_tool_result',
      });
      forwardToConnections(dbSessionId, { type: 'claude_message', data: msg });
    });

    client.on('result', (result) => {
      if (DEBUG_CHAT_WS) {
        const res = result as { uuid?: string };
        logger.info('[Chat WS] Received result event from client', { dbSessionId, uuid: res.uuid });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'result', data: result });
      forwardToConnections(dbSessionId, { type: 'claude_message', data: result });

      forwardToConnections(dbSessionId, {
        type: 'status',
        running: false,
      });
    });

    client.on('exit', (result) => {
      forwardToConnections(dbSessionId, {
        type: 'process_exit',
        code: result.code,
      });
      client.removeAllListeners();
      chatClients.delete(dbSessionId);
      pendingMessages.delete(dbSessionId);
    });

    client.on('error', (error) => {
      forwardToConnections(dbSessionId, { type: 'error', message: error.message });
    });
  }

  async function getOrCreateChatClient(
    dbSessionId: string,
    options: {
      workingDir: string;
      resumeClaudeSessionId?: string;
      systemPrompt?: string;
      model?: string;
      thinkingEnabled?: boolean;
      permissionMode?: 'bypassPermissions' | 'plan';
    }
  ): Promise<ClaudeClient> {
    let client = chatClients.get(dbSessionId);
    if (client?.isRunning()) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Reusing existing running client', { dbSessionId });
      }
      return client;
    }

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
        resumeClaudeSessionId: options.resumeClaudeSessionId,
      });
    }

    const createPromise = (async () => {
      const clientOptions: ClaudeClientOptions = {
        workingDir: options.workingDir,
        resumeClaudeSessionId: options.resumeClaudeSessionId,
        systemPrompt: options.systemPrompt,
        model: options.model,
        permissionMode: options.permissionMode ?? 'bypassPermissions',
        includePartialMessages: true,
        thinkingEnabled: options.thinkingEnabled,
      };

      try {
        const session = await claudeSessionAccessor.findById(dbSessionId);
        const workspaceId = session?.workspaceId ?? 'unknown';

        const newClient = await ClaudeClient.create({
          ...clientOptions,
          sessionId: dbSessionId,
        });

        setupChatClientEvents(dbSessionId, newClient, {
          workspaceId,
          workingDir: options.workingDir,
        });
        chatClients.set(dbSessionId, newClient);

        return newClient;
      } catch (error) {
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
      systemPrompt?: string;
      model?: string;
      thinkingEnabled?: boolean;
      planModeEnabled?: boolean;
      selectedModel?: string | null;
    }
  ) {
    switch (message.type) {
      case 'start': {
        ws.send(JSON.stringify({ type: 'starting', dbSessionId }));

        const sessionOpts = await sessionService.getSessionOptions(dbSessionId);
        if (!sessionOpts) {
          logger.error('[Chat WS] Failed to get session options', { dbSessionId });
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          break;
        }

        const permissionMode = message.planModeEnabled ? 'plan' : 'bypassPermissions';

        const validModels = ['sonnet', 'opus'];
        const requestedModel = message.selectedModel || message.model;
        const model =
          requestedModel && validModels.includes(requestedModel)
            ? requestedModel
            : sessionOpts.model;

        await getOrCreateChatClient(dbSessionId, {
          workingDir: sessionOpts.workingDir,
          resumeClaudeSessionId: sessionOpts.resumeClaudeSessionId,
          systemPrompt: sessionOpts.systemPrompt,
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
          client.sendMessage(text);
        } else {
          let queue = pendingMessages.get(dbSessionId);
          if (!queue) {
            queue = [];
            pendingMessages.set(dbSessionId, queue);
          }

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

          ws.send(JSON.stringify({ type: 'message_queued', text }));
          ws.send(JSON.stringify({ type: 'starting', dbSessionId }));

          const sessionOpts = await sessionService.getSessionOptions(dbSessionId);
          if (!sessionOpts) {
            logger.error('[Chat WS] Failed to get session options for auto-start', { dbSessionId });
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
            break;
          }

          const permissionMode = message.planModeEnabled ? 'plan' : 'bypassPermissions';

          const validModels = ['sonnet', 'opus'];
          const requestedModel = message.selectedModel || message.model;
          const model =
            requestedModel && validModels.includes(requestedModel)
              ? requestedModel
              : sessionOpts.model;

          const newClient = await getOrCreateChatClient(dbSessionId, {
            workingDir: sessionOpts.workingDir,
            resumeClaudeSessionId: sessionOpts.resumeClaudeSessionId,
            systemPrompt: sessionOpts.systemPrompt,
            model,
            thinkingEnabled: message.thinkingEnabled,
            permissionMode,
          });
          ws.send(JSON.stringify({ type: 'started', dbSessionId }));

          const pending = pendingMessages.get(dbSessionId);
          pendingMessages.delete(dbSessionId);
          if (pending && pending.length > 0) {
            logger.info('[Chat WS] Sending queued messages after client ready', {
              dbSessionId,
              count: pending.length,
            });
            for (const msg of pending) {
              newClient.sendMessage(msg.text);
            }
          }
        }
        break;
      }

      case 'stop': {
        const client = chatClients.get(dbSessionId);
        if (client) {
          try {
            await client.stop();
          } catch {
            client.kill();
          }
          chatClients.delete(dbSessionId);
        }
        pendingMessages.delete(dbSessionId);
        ws.send(JSON.stringify({ type: 'stopped', dbSessionId }));
        break;
      }

      case 'get_history': {
        const client = chatClients.get(dbSessionId);
        const claudeSessionId = client?.getClaudeSessionId();
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
        const dbSession = await claudeSessionAccessor.findById(dbSessionId);
        if (!dbSession) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          break;
        }

        const targetSessionId = dbSession.claudeSessionId ?? null;

        const existingClient = chatClients.get(dbSessionId);
        const running = existingClient?.isWorking() ?? false;

        if (targetSessionId) {
          const [history, model, thinkingEnabled, gitBranch] = await Promise.all([
            SessionManager.getHistory(targetSessionId, workingDir),
            SessionManager.getSessionModel(targetSessionId, workingDir),
            SessionManager.getSessionThinkingEnabled(targetSessionId, workingDir),
            SessionManager.getSessionGitBranch(targetSessionId, workingDir),
          ]);

          const selectedModel = model?.includes('opus')
            ? 'opus'
            : model?.includes('haiku')
              ? 'haiku'
              : null;

          ws.send(
            JSON.stringify({
              type: 'session_loaded',
              messages: history,
              gitBranch,
              running,
              settings: {
                selectedModel,
                thinkingEnabled,
                planModeEnabled: false,
              },
            })
          );
        } else {
          ws.send(
            JSON.stringify({
              type: 'session_loaded',
              messages: [],
              gitBranch: null,
              running,
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

  function validateWorkingDir(workingDir: string): string | null {
    if (workingDir.includes('..')) {
      return null;
    }

    if (!workingDir.startsWith('/')) {
      return null;
    }

    const normalized = resolve(workingDir);

    if (!existsSync(normalized)) {
      return null;
    }

    let realPath: string;
    try {
      realPath = realpathSync(normalized);
    } catch {
      return null;
    }

    let worktreeBaseDir: string;
    try {
      worktreeBaseDir = realpathSync(configService.getWorktreeBaseDir());
    } catch {
      return null;
    }
    if (!realPath.startsWith(`${worktreeBaseDir}/`) && realPath !== worktreeBaseDir) {
      return null;
    }

    return realPath;
  }

  function handleChatUpgrade(
    request: import('http').IncomingMessage,
    socket: import('stream').Duplex,
    head: Buffer,
    url: URL
  ) {
    const connectionId = url.searchParams.get('connectionId') || `conn-${Date.now()}`;
    const dbSessionId = url.searchParams.get('sessionId');
    const rawWorkingDir = url.searchParams.get('workingDir');

    if (!dbSessionId) {
      logger.warn('Missing sessionId (dbSessionId) parameter', { connectionId });
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing sessionId parameter');
      socket.destroy();
      return;
    }

    if (!rawWorkingDir) {
      logger.warn('Missing workingDir parameter', { dbSessionId, connectionId });
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing workingDir parameter');
      socket.destroy();
      return;
    }

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
      });

      wsAliveMap.set(ws, true);
      ws.on('pong', () => wsAliveMap.set(ws, true));

      sessionFileLogger.initSession(dbSessionId);
      sessionFileLogger.log(dbSessionId, 'INFO', {
        event: 'connection_established',
        connectionId,
        dbSessionId,
        workingDir,
      });

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

      chatConnections.set(connectionId, {
        ws,
        dbSessionId,
        workingDir,
      });

      if (DEBUG_CHAT_WS) {
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

      const client = chatClients.get(dbSessionId);
      const isRunning = client?.isWorking() ?? false;

      const initialStatus = {
        type: 'status',
        dbSessionId,
        running: isRunning,
      };
      sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', initialStatus);
      ws.send(JSON.stringify(initialStatus));

      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          sessionFileLogger.log(dbSessionId, 'IN_FROM_CLIENT', message);
          await handleChatMessage(ws, connectionId, dbSessionId, workingDir, message);
        } catch (error) {
          logger.error('Error handling chat message', error as Error);
          const errorResponse = { type: 'error', message: 'Invalid message format' };
          sessionFileLogger.log(dbSessionId, 'OUT_TO_CLIENT', errorResponse);
          ws.send(JSON.stringify(errorResponse));
        }
      });

      ws.on('close', () => {
        logger.info('Chat WebSocket connection closed', { connectionId, dbSessionId });
        sessionFileLogger.log(dbSessionId, 'INFO', { event: 'connection_closed', connectionId });
        sessionFileLogger.closeSession(dbSessionId);

        chatConnections.delete(connectionId);
      });

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

  const terminalConnections = new Map<string, Set<import('ws').WebSocket>>();
  const terminalListenerCleanup = new WeakMap<
    import('ws').WebSocket,
    Map<string, (() => void)[]>
  >();

  const TERMINAL_GRACE_PERIOD_MS = 30_000;
  const terminalGracePeriods = new Map<string, NodeJS.Timeout>();

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

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Terminal WebSocket handler
    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info('Terminal WebSocket connection established', { workspaceId });

      wsAliveMap.set(ws, true);
      ws.on('pong', () => wsAliveMap.set(ws, true));

      const existingGracePeriod = terminalGracePeriods.get(workspaceId);
      if (existingGracePeriod) {
        clearTimeout(existingGracePeriod);
        terminalGracePeriods.delete(workspaceId);
        logger.info('Cancelled terminal grace period due to reconnection', { workspaceId });
      }

      if (!terminalConnections.has(workspaceId)) {
        terminalConnections.set(workspaceId, new Set());
      }
      terminalConnections.get(workspaceId)?.add(ws);

      terminalListenerCleanup.set(ws, new Map());

      logger.debug('Sending initial status message', { workspaceId });
      ws.send(JSON.stringify({ type: 'status', connected: true }));

      const existingTerminals = terminalService.getTerminalsForWorkspace(workspaceId);
      if (existingTerminals.length > 0) {
        logger.info('Sending existing terminal list for restoration', {
          workspaceId,
          terminalCount: existingTerminals.length,
        });

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

        const existingConnections = terminalConnections.get(workspaceId);
        if (existingConnections) {
          for (const existingWs of existingConnections) {
            if (existingWs !== ws) {
              logger.debug('Cleaning up listeners from existing connection', { workspaceId });
              cleanupTerminalListeners(existingWs);
            }
          }
        }

        const cleanupMap = terminalListenerCleanup.get(ws);
        for (const terminal of existingTerminals) {
          const unsubscribers: (() => void)[] = [];
          if (cleanupMap) {
            cleanupMap.set(terminal.id, unsubscribers);
          }

          const unsubOutput = terminalService.onOutput(terminal.id, (output) => {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'output', terminalId: terminal.id, data: output }));
            }
          });
          unsubscribers.push(unsubOutput);

          const unsubExit = terminalService.onExit(terminal.id, (exitCode) => {
            logger.info('Terminal process exited', { terminalId: terminal.id, exitCode });
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'exit', terminalId: terminal.id, exitCode }));
            }
            const exitCleanupMap = terminalListenerCleanup.get(ws);
            if (exitCleanupMap) {
              exitCleanupMap.delete(terminal.id);
            }
            terminalSessionAccessor.clearPid(terminal.id).catch((err) => {
              logger.warn('Failed to clear terminal PID', { terminalId: terminal.id, error: err });
            });
          });
          unsubscribers.push(unsubExit);
        }
      }

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
              const workspace = await workspaceAccessor.findById(workspaceId);
              if (!workspace?.worktreePath) {
                logger.warn('Workspace not found or has no worktree', { workspaceId });
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Workspace not found or has no worktree',
                  })
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

              await terminalSessionAccessor.create({
                workspaceId,
                name: terminalId,
                pid,
              });

              const cleanupMap = terminalListenerCleanup.get(ws);
              const unsubscribers: (() => void)[] = [];
              if (cleanupMap) {
                cleanupMap.set(terminalId, unsubscribers);
              }

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

              const unsubExit = terminalService.onExit(terminalId, (exitCode) => {
                logger.info('Terminal process exited', { terminalId, exitCode });
                if (ws.readyState === 1) {
                  ws.send(JSON.stringify({ type: 'exit', terminalId, exitCode }));
                }
                const exitCleanupMap = terminalListenerCleanup.get(ws);
                if (exitCleanupMap) {
                  exitCleanupMap.delete(terminalId);
                }
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

            case 'set_active': {
              if (message.terminalId) {
                logger.debug('Setting active terminal', {
                  workspaceId,
                  terminalId: message.terminalId,
                });
                terminalService.setActiveTerminal(workspaceId, message.terminalId);
              }
              break;
            }

            default:
              logger.warn('Unknown message type', { type: message.type });
          }
        } catch (error) {
          const err = error as Error;
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

      ws.on('close', () => {
        logger.info('Terminal WebSocket connection closed', { workspaceId });

        cleanupTerminalListeners(ws);

        const connections = terminalConnections.get(workspaceId);
        if (connections) {
          connections.delete(ws);
          if (connections.size === 0) {
            terminalConnections.delete(workspaceId);
            logger.info('Starting terminal grace period', {
              workspaceId,
              gracePeriodMs: TERMINAL_GRACE_PERIOD_MS,
            });
            const gracePeriodTimeout = setTimeout(() => {
              if (!terminalConnections.has(workspaceId)) {
                logger.info('Grace period expired, destroying workspace terminals', {
                  workspaceId,
                });
                terminalService.destroyWorkspaceTerminals(workspaceId);
              }
              terminalGracePeriods.delete(workspaceId);
            }, TERMINAL_GRACE_PERIOD_MS);
            terminalGracePeriods.set(workspaceId, gracePeriodTimeout);
          }
        }
      });

      ws.on('error', (error) => {
        logger.error('Terminal WebSocket error', error);
      });
    });
  }

  // ============================================================================
  // WebSocket Upgrade Handler
  // ============================================================================

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/chat') {
      handleChatUpgrade(request, socket, head, url);
      return;
    }

    if (url.pathname === '/terminal') {
      handleTerminalUpgrade(request, socket, head, url);
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

    for (const [workspaceId, timeout] of terminalGracePeriods) {
      clearTimeout(timeout);
      logger.debug('Cancelled terminal grace period during shutdown', { workspaceId });
    }
    terminalGracePeriods.clear();

    wss.close();
    server.close();

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
        try {
          client.kill();
        } catch {
          // Ignore kill errors
        }
      });
      stopPromises.push(stopPromise);
      logger.debug('Stopping chat client', { sessionId });
    }

    await Promise.all(stopPromises);

    for (const client of chatClients.values()) {
      client.removeAllListeners();
    }
    chatClients.clear();

    terminalService.cleanup();
    agentProcessAdapter.cleanup();
    sessionFileLogger.cleanup();

    await schedulerService.stop();
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

          try {
            await reconciliationService.cleanupOrphans();
          } catch (error) {
            logger.error('Failed to cleanup orphan sessions on startup', error as Error);
          }

          sessionFileLogger.cleanupOldLogs();
          reconciliationService.startPeriodicCleanup();
          schedulerService.start();

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
