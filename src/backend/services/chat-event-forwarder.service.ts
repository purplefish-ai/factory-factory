/**
 * Chat Event Forwarder Service
 *
 * Handles Claude client event setup and interactive request routing.
 * Responsible for:
 * - Setting up event listeners on ClaudeClient instances
 * - Forwarding client events to WebSocket connections
 * - Managing pending interactive requests for session restore
 * - Routing interactive tool requests to appropriate message formats
 */

import { existsSync, readFileSync } from 'node:fs';
import type { PendingInteractiveRequest } from '../../shared/pending-request-types';
import type { ClaudeClient } from '../claude/index';
import { WS_READY_STATE } from '../constants';
import { interceptorRegistry } from '../interceptors';
import {
  AskUserQuestionInputSchema,
  ExitPlanModeInputSchema,
  extractInputValue,
  isString,
  safeParseToolInput,
} from '../schemas/tool-inputs.schema';
import { chatConnectionService } from './chat-connection.service';
import { configService } from './config.service';
import { createLogger } from './logger.service';
import { messageStateService } from './message-state.service';
import { sessionFileLogger } from './session-file-logger.service';
import { slashCommandCacheService } from './slash-command-cache.service';
import { workspaceActivityService } from './workspace-activity.service';

const logger = createLogger('chat-event-forwarder');

const DEBUG_CHAT_WS = configService.getDebugConfig().chatWebSocket;

// ============================================================================
// Types
// ============================================================================

export interface EventForwarderContext {
  workspaceId: string;
  workingDir: string;
}

/** Narrow interface for safely accessing event type in logs */
interface EventForLogging {
  type?: string;
}

// ============================================================================
// Service
// ============================================================================

class ChatEventForwarderService {
  /** Tracks which sessions have event forwarding set up */
  private clientEventSetup = new Set<string>();

  /** Pending interactive requests by session ID (for restore on reconnect) */
  private pendingInteractiveRequests = new Map<string, PendingInteractiveRequest>();

  /** Guard to prevent multiple workspace notification setups */
  private workspaceNotificationsSetup = false;
  /** Track last compact boundary per session to avoid duplicate indicators */
  private lastCompactBoundaryAt = new Map<string, number>();

  /**
   * Check if event forwarding is already set up for a session.
   */
  isSetup(dbSessionId: string): boolean {
    return this.clientEventSetup.has(dbSessionId);
  }

  /**
   * Get pending interactive request for a session.
   */
  getPendingRequest(dbSessionId: string): PendingInteractiveRequest | undefined {
    return this.pendingInteractiveRequests.get(dbSessionId);
  }

  /**
   * Clear pending interactive request unconditionally.
   * Used when stopping a session - the pending request is no longer valid.
   */
  clearPendingRequest(dbSessionId: string): void {
    this.pendingInteractiveRequests.delete(dbSessionId);
  }

  /**
   * Clear pending interactive request only if the requestId matches.
   * Prevents clearing a newer request when responding to a stale one.
   */
  clearPendingRequestIfMatches(dbSessionId: string, requestId: string): void {
    const pending = this.pendingInteractiveRequests.get(dbSessionId);
    if (pending?.requestId === requestId) {
      this.pendingInteractiveRequests.delete(dbSessionId);
    }
  }

  /**
   * Set up workspace-level notification forwarding.
   * Call this once during handler initialization.
   */
  setupWorkspaceNotifications(): void {
    if (this.workspaceNotificationsSetup) {
      return; // Already set up
    }
    this.workspaceNotificationsSetup = true;

    workspaceActivityService.on('request_notification', (data) => {
      const { workspaceId, workspaceName, sessionCount, finishedAt } = data;

      logger.debug('Broadcasting workspace notification request', { workspaceId });

      // Send to all open connections so any workspace can hear the notification
      const message = JSON.stringify({
        type: 'workspace_notification_request',
        workspaceId,
        workspaceName,
        sessionCount,
        finishedAt: finishedAt.toISOString(),
      });

      for (const info of chatConnectionService.values()) {
        if (info.ws.readyState === WS_READY_STATE.OPEN) {
          try {
            info.ws.send(message);
          } catch (error) {
            logger.error('Failed to send workspace notification', error as Error);
          }
        }
      }
    });
  }

  /**
   * Set up event forwarding from a ClaudeClient to WebSocket connections.
   * This is idempotent - safe to call multiple times for the same session.
   */
  setupClientEvents(
    dbSessionId: string,
    client: ClaudeClient,
    context: EventForwarderContext,
    onDispatchNextMessage: () => Promise<void>
  ): void {
    // Idempotent: skip if already set up for this session
    if (this.clientEventSetup.has(dbSessionId)) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Event forwarding already set up, skipping', { dbSessionId });
      }
      return;
    }
    this.clientEventSetup.add(dbSessionId);

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Setting up event forwarding for session', { dbSessionId });
    }

    // Store-then-forward slash commands from initialize response (sent once per session setup)
    const initResponse = client.getInitializeResponse();
    if (initResponse?.commands && initResponse.commands.length > 0) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Forwarding slash commands to frontend', {
          dbSessionId,
          commandCount: initResponse.commands.length,
        });
      }
      const slashCommandsMsg = {
        type: 'slash_commands',
        slashCommands: initResponse.commands,
      };
      messageStateService.storeEvent(dbSessionId, slashCommandsMsg);
      chatConnectionService.forwardToSession(dbSessionId, slashCommandsMsg);
      void slashCommandCacheService.setCachedCommands(initResponse.commands);
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

    // Note: DB update for claudeSessionId is now handled by sessionService.setupClientDbHandlers()
    client.on('session_id', (claudeSessionId) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received session_id from Claude CLI', {
          dbSessionId,
          claudeSessionId,
        });
      }

      // Mark workspace as active
      workspaceActivityService.markSessionRunning(context.workspaceId, dbSessionId);

      // Store-then-forward: store event for replay before forwarding
      const statusMsg = { type: 'status', running: true, processAlive: client.isRunning() };
      messageStateService.storeEvent(dbSessionId, statusMsg);
      chatConnectionService.forwardToSession(dbSessionId, statusMsg);
    });

    // Hook into idle event to dispatch next queued message
    client.on('idle', () => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Claude became idle, checking queue', { dbSessionId });
      }
      // Fire and forget - don't await
      onDispatchNextMessage().catch((error) => {
        logger.error('[Chat WS] Error dispatching queued message on idle', {
          dbSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    client.on('stream', (event) => {
      const streamEvent = event as EventForLogging;
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received stream event from client', {
          dbSessionId,
          eventType: streamEvent.type,
        });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'stream', data: event });

      // Store-then-forward: store event for replay before forwarding
      // Include order for consistent frontend message sorting
      const order = messageStateService.allocateOrder(dbSessionId);
      const msg = { type: 'claude_message', data: event, order };
      messageStateService.storeEvent(dbSessionId, msg);
      chatConnectionService.forwardToSession(dbSessionId, msg);
    });

    // SDK message types - forwarded as dedicated event types
    client.on('tool_progress', (event) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received tool_progress event', { dbSessionId });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'tool_progress',
        data: event,
      });
      const sdkEvent = event as unknown as { type: string };
      messageStateService.storeEvent(dbSessionId, sdkEvent);
      chatConnectionService.forwardToSession(dbSessionId, sdkEvent);
    });

    client.on('tool_use_summary', (event) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received tool_use_summary event', { dbSessionId });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'tool_use_summary',
        data: event,
      });
      const sdkEvent = event as unknown as { type: string };
      messageStateService.storeEvent(dbSessionId, sdkEvent);
      chatConnectionService.forwardToSession(dbSessionId, sdkEvent);
    });

    // System subtype event handlers
    client.on('system_init', (event) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received system_init event', {
          dbSessionId,
          tools: event.tools?.length ?? 0,
          model: event.model,
        });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'system_init',
        data: event,
      });
      const msg = {
        type: 'system_init',
        data: {
          tools: event.tools,
          model: event.model,
          cwd: event.cwd,
          apiKeySource: event.apiKeySource,
          slashCommands: event.slash_commands,
          plugins: event.plugins,
        },
      };
      messageStateService.storeEvent(dbSessionId, msg);
      chatConnectionService.forwardToSession(dbSessionId, msg);
    });

    client.on('system_status', (event) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received system_status event', {
          dbSessionId,
          status: event.status,
          permission_mode: event.permission_mode,
        });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'system_status',
        data: event,
      });
      const msg = {
        type: 'status_update',
        permissionMode: event.permission_mode,
      };
      messageStateService.storeEvent(dbSessionId, msg);
      chatConnectionService.forwardToSession(dbSessionId, msg);
    });

    client.on('compact_boundary', (event) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received compact_boundary event', { dbSessionId });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'compact_boundary',
        data: event,
      });
      const now = Date.now();
      const lastBoundary = this.lastCompactBoundaryAt.get(dbSessionId) ?? 0;
      if (now - lastBoundary < 1000) {
        return;
      }
      this.lastCompactBoundaryAt.set(dbSessionId, now);
      const boundaryMsg = { type: 'compact_boundary' };
      messageStateService.storeEvent(dbSessionId, boundaryMsg);
      chatConnectionService.forwardToSession(dbSessionId, boundaryMsg);
    });

    client.on('hook_started', (event) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received hook_started event', {
          dbSessionId,
          hookId: event.hook_id,
          hookName: event.hook_name,
          hookEvent: event.hook_event,
        });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'hook_started',
        data: event,
      });
      const msg = {
        type: 'hook_started',
        data: {
          hookId: event.hook_id,
          hookName: event.hook_name,
          hookEvent: event.hook_event,
        },
      };
      messageStateService.storeEvent(dbSessionId, msg);
      chatConnectionService.forwardToSession(dbSessionId, msg);
    });

    client.on('hook_response', (event) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received hook_response event', {
          dbSessionId,
          hookId: event.hook_id,
          exitCode: event.exit_code,
          outcome: event.outcome,
        });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'hook_response',
        data: event,
      });
      const msg = {
        type: 'hook_response',
        data: {
          hookId: event.hook_id,
          output: event.output,
          stdout: event.stdout,
          stderr: event.stderr,
          exitCode: event.exit_code,
          outcome: event.outcome,
        },
      };
      messageStateService.storeEvent(dbSessionId, msg);
      chatConnectionService.forwardToSession(dbSessionId, msg);
    });

    // Context compaction events
    client.on('compacting_start', () => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Context compaction started', { dbSessionId });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'compacting_start' });
      const event = { type: 'compacting_start' };
      messageStateService.storeEvent(dbSessionId, event);
      chatConnectionService.forwardToSession(dbSessionId, event);
    });

    client.on('compacting_end', () => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Context compaction ended', { dbSessionId });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'compacting_end' });
      const event = { type: 'compacting_end' };
      messageStateService.storeEvent(dbSessionId, event);
      chatConnectionService.forwardToSession(dbSessionId, event);
    });

    client.on('message', (msg) => {
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'message', data: msg });

      const msgWithType = msg as {
        type?: string;
        uuid?: string;
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

      // Forward user message UUID for rewind functionality
      // This allows the frontend to track which SDK-assigned UUID corresponds to each message
      if (msgWithType.uuid) {
        const uuidMsg = { type: 'user_message_uuid', uuid: msgWithType.uuid };
        messageStateService.storeEvent(dbSessionId, uuidMsg);
        chatConnectionService.forwardToSession(dbSessionId, uuidMsg);
        if (DEBUG_CHAT_WS) {
          logger.info('[Chat WS] Forwarding user message UUID', {
            dbSessionId,
            uuid: msgWithType.uuid,
          });
        }
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

      this.notifyToolResultInterceptors(content, pendingToolNames, pendingToolInputs, {
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
      // Store-then-forward: store event for replay before forwarding
      // Include order for consistent frontend message sorting
      const order = messageStateService.allocateOrder(dbSessionId);
      const wsMsg = { type: 'claude_message', data: msg, order };
      messageStateService.storeEvent(dbSessionId, wsMsg);
      chatConnectionService.forwardToSession(dbSessionId, wsMsg);
    });

    client.on('result', (result) => {
      if (DEBUG_CHAT_WS) {
        const res = result as { uuid?: string };
        logger.info('[Chat WS] Received result event from client', { dbSessionId, uuid: res.uuid });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'result', data: result });
      // Store-then-forward: store events for replay before forwarding
      // Include order for consistent frontend message sorting
      const order = messageStateService.allocateOrder(dbSessionId);
      const resultMsg = { type: 'claude_message', data: result, order };
      messageStateService.storeEvent(dbSessionId, resultMsg);
      chatConnectionService.forwardToSession(dbSessionId, resultMsg);

      // Mark session as idle
      workspaceActivityService.markSessionIdle(context.workspaceId, dbSessionId);

      const statusMsg = { type: 'status', running: false, processAlive: client.isRunning() };
      messageStateService.storeEvent(dbSessionId, statusMsg);
      chatConnectionService.forwardToSession(dbSessionId, statusMsg);
    });

    // Forward interactive tool requests (e.g., AskUserQuestion) to frontend
    client.on('interactive_request', (request) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received interactive_request from client', {
          dbSessionId,
          toolName: request.toolName,
          requestId: request.requestId,
        });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'interactive_request',
        data: request,
      });

      this.routeInteractiveRequest(dbSessionId, request);
    });

    client.on('exit', (result) => {
      chatConnectionService.forwardToSession(dbSessionId, {
        type: 'process_exit',
        code: result.code,
        processAlive: false,
      });
      client.removeAllListeners();
      this.clientEventSetup.delete(dbSessionId);
      this.lastCompactBoundaryAt.delete(dbSessionId);
      // Note: We intentionally do NOT clear the message queue on exit
      // Queue is preserved so messages can be sent when user starts next interaction
      // Clear any pending interactive requests when process exits
      this.pendingInteractiveRequests.delete(dbSessionId);
      // Clear message state to prevent memory leak
      messageStateService.clearSession(dbSessionId);
    });

    // Forward request cancellation to frontend (e.g., when CLI cancels during permission or question prompt)
    client.on('permission_cancelled', (requestId: string) => {
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'permission_cancelled',
        requestId,
      });
      // Only clear if the requestId matches to avoid race conditions with newer requests
      this.clearPendingRequestIfMatches(dbSessionId, requestId);
      chatConnectionService.forwardToSession(dbSessionId, {
        type: 'permission_cancelled',
        requestId,
      });
    });

    client.on('error', (error) => {
      chatConnectionService.forwardToSession(dbSessionId, {
        type: 'error',
        message: error.message,
      });
    });
  }

  /**
   * Route interactive tool requests to the appropriate WebSocket message format.
   * Also stores the request for session restore when user navigates away and returns.
   */
  private routeInteractiveRequest(
    dbSessionId: string,
    request: {
      requestId: string;
      toolName: string;
      toolUseId: string;
      input: Record<string, unknown>;
    }
  ): void {
    // Compute planContent for ExitPlanMode, null for others
    const planContent =
      request.toolName === 'ExitPlanMode' ? this.extractPlanContent(request.input) : null;

    // Store for session restore (single location for all request types)
    this.pendingInteractiveRequests.set(dbSessionId, {
      requestId: request.requestId,
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      input: request.input,
      planContent,
      timestamp: new Date().toISOString(),
    });

    // Route to appropriate WebSocket message format
    if (request.toolName === 'AskUserQuestion') {
      const parsed = safeParseToolInput(
        AskUserQuestionInputSchema,
        request.input,
        'AskUserQuestion',
        logger
      );

      // Validate and extract questions
      if (!parsed.success || parsed.data.questions.length === 0) {
        logger.warn('[Chat WS] Invalid or empty AskUserQuestion input', {
          dbSessionId,
          requestId: request.requestId,
          validationSuccess: parsed.success,
        });
        chatConnectionService.forwardToSession(dbSessionId, {
          type: 'error',
          message: 'Received invalid question format from CLI',
        });
        return;
      }

      chatConnectionService.forwardToSession(dbSessionId, {
        type: 'user_question',
        requestId: request.requestId,
        questions: parsed.data.questions,
      });
      return;
    }

    if (request.toolName === 'ExitPlanMode') {
      chatConnectionService.forwardToSession(dbSessionId, {
        type: 'permission_request',
        requestId: request.requestId,
        toolName: request.toolName,
        input: request.input,
        planContent,
      });
      return;
    }

    // Fallback: send as generic interactive_request
    chatConnectionService.forwardToSession(dbSessionId, {
      type: 'interactive_request',
      requestId: request.requestId,
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      input: request.input,
    });
  }

  /**
   * Extract plan content from ExitPlanMode input.
   * Handles both SDK format (inline `plan`) and CLI format (`planFile` path).
   *
   * Priority: inline `plan` content > `planFile` content
   */
  private extractPlanContent(input: Record<string, unknown>): string | null {
    // Validate input structure (logs warning if invalid)
    const parsed = ExitPlanModeInputSchema.safeParse(input);
    if (!parsed.success) {
      logger.warn('[Chat WS] ExitPlanMode input validation failed', {
        errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        inputKeys: Object.keys(input),
      });
    }

    // Check for inline plan content first (SDK format - preferred)
    const inlinePlan = extractInputValue(input, 'plan', isString, 'ExitPlanMode', logger);
    if (inlinePlan) {
      return inlinePlan;
    }

    // Fall back to planFile path (CLI format)
    const planFile = extractInputValue(input, 'planFile', isString, 'ExitPlanMode', logger);
    if (planFile) {
      return this.readPlanFileContent(planFile);
    }

    return null;
  }

  /**
   * Read plan file content for ExitPlanMode requests.
   * Returns null if file doesn't exist (normal case) or on read error.
   */
  private readPlanFileContent(planFile: string): string | null {
    if (!existsSync(planFile)) {
      // File not existing is normal - plan may not have been written yet
      logger.debug('[Chat WS] Plan file does not exist', { planFile });
      return null;
    }

    try {
      return readFileSync(planFile, 'utf-8');
    } catch (error) {
      // File exists but can't be read - this is an error condition
      logger.error('[Chat WS] Failed to read plan file - user will see empty plan content', {
        planFile,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Notify interceptors about tool results.
   */
  private notifyToolResultInterceptors(
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
}

export const chatEventForwarderService = new ChatEventForwarderService();
