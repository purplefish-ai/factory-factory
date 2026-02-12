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

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { WS_READY_STATE } from '@/backend/constants';
import type { SessionWorkspaceBridge } from '@/backend/domains/session/bridges';
import type { ClaudeClient } from '@/backend/domains/session/claude/index';
import { sessionFileLogger } from '@/backend/domains/session/logging/session-file-logger.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { slashCommandCacheService } from '@/backend/domains/session/store/slash-command-cache.service';
import { interceptorRegistry } from '@/backend/interceptors';
import type { EventEmitterListener } from '@/backend/lib/event-emitter-types';
import {
  AskUserQuestionInputSchema,
  ExitPlanModeInputSchema,
  extractInputValue,
  isString,
  safeParseToolInput,
} from '@/backend/schemas/tool-inputs.schema';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { type ClaudeContentItem, type ClaudeMessage, hasToolResultContent } from '@/shared/claude';
import {
  type InteractiveResponseTool,
  isInteractiveResponseTool,
  type PendingInteractiveRequest,
} from '@/shared/pending-request-types';
import { chatConnectionService } from './chat-connection.service';

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
// Constants
// ============================================================================

interface RegisteredListener {
  event: string;
  handler: EventEmitterListener;
}

// ============================================================================
// Service
// ============================================================================

class ChatEventForwarderService {
  /** Tracks which sessions have event forwarding set up, mapping to the client instance */
  private clientEventSetup = new Map<string, ClaudeClient>();

  /** Stores the specific listener references this service attached, for precise teardown */
  private registeredListeners = new Map<string, RegisteredListener[]>();

  /** Guard to prevent multiple workspace notification setups */
  private workspaceNotificationsSetup = false;
  /** Track last compact boundary per session to avoid duplicate indicators */
  private lastCompactBoundaryAt = new Map<string, number>();

  /** Cross-domain bridge for workspace activity (injected by orchestration layer) */
  private workspaceBridge: SessionWorkspaceBridge | null = null;

  /**
   * Configure cross-domain bridges. Called once at startup by orchestration layer.
   */
  configure(bridges: { workspace: SessionWorkspaceBridge }): void {
    this.workspaceBridge = bridges.workspace;
  }

  private get workspace(): SessionWorkspaceBridge {
    if (!this.workspaceBridge) {
      throw new Error(
        'ChatEventForwarderService not configured: workspace bridge missing. Call configure() first.'
      );
    }
    return this.workspaceBridge;
  }

  private forwardClaudeMessage(dbSessionId: string, message: ClaudeMessage): void {
    const order = sessionDomainService.appendClaudeEvent(dbSessionId, message);
    const wsMsg =
      order === undefined
        ? ({ type: 'claude_message', data: message } as const)
        : ({ type: 'claude_message', data: message, order } as const);
    sessionDomainService.emitDelta(dbSessionId, wsMsg);
  }

  /**
   * Remove only the specific listener functions that this service attached to a client.
   * Preserves listeners from other services (DB handlers, process manager, etc.).
   */
  private removeForwardingListeners(dbSessionId: string, client: ClaudeClient): void {
    const listeners = this.registeredListeners.get(dbSessionId);
    if (listeners) {
      for (const { event, handler } of listeners) {
        client.off(event, handler);
      }
      this.registeredListeners.delete(dbSessionId);
    }
  }

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
    return sessionDomainService.getPendingInteractiveRequest(dbSessionId) ?? undefined;
  }

  /**
   * Clear pending interactive request unconditionally.
   * Used when stopping a session - the pending request is no longer valid.
   */
  clearPendingRequest(dbSessionId: string): void {
    sessionDomainService.clearPendingInteractiveRequest(dbSessionId);
  }

  /**
   * Clear pending interactive request only if the requestId matches.
   * Prevents clearing a newer request when responding to a stale one.
   */
  clearPendingRequestIfMatches(dbSessionId: string, requestId: string): void {
    sessionDomainService.clearPendingInteractiveRequestIfMatches(dbSessionId, requestId);
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

    this.workspace.on('request_notification', (data) => {
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
    // Idempotent: skip if already set up for the same client instance
    const existingClient = this.clientEventSetup.get(dbSessionId);
    if (existingClient === client) {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Event forwarding already set up for same client, skipping', {
          dbSessionId,
        });
      }
      return;
    }

    // If a different client was previously set up, tear down old listeners
    // This happens when a new Claude process replaces an existing one for the same session
    if (existingClient) {
      logger.info('[Chat WS] Replacing event forwarding with new client', { dbSessionId });
      this.removeForwardingListeners(dbSessionId, existingClient);
      // Clear stale interactive requests from the old client so the UI
      // doesn't try to respond to a request the new client knows nothing about
      sessionDomainService.clearPendingInteractiveRequest(dbSessionId);
    }

    this.clientEventSetup.set(dbSessionId, client);

    if (DEBUG_CHAT_WS) {
      logger.info('[Chat WS] Setting up event forwarding for session', { dbSessionId });
    }

    // Helper to register a listener and track it for precise teardown later.
    // Uses EventEmitter.prototype.on to bypass ClaudeClient's typed overloads.
    const emitterOn = EventEmitter.prototype.on.bind(client);
    const listeners: RegisteredListener[] = [];
    const on = (event: string, handler: EventEmitterListener) => {
      emitterOn(event, handler);
      listeners.push({ event, handler });
    };
    this.registeredListeners.set(dbSessionId, listeners);

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
      } as const;
      sessionDomainService.emitDelta(dbSessionId, slashCommandsMsg);
      void slashCommandCacheService.setCachedCommands(initResponse.commands);
    }

    const pendingToolNames = new Map<string, string>();
    const pendingToolInputs = new Map<string, Record<string, unknown>>();

    on('tool_use', (toolUse) => {
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
    on('session_id', (claudeSessionId) => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Received session_id from Claude CLI', {
          dbSessionId,
          claudeSessionId,
        });
      }

      // Mark workspace as active
      this.workspace.markSessionRunning(context.workspaceId, dbSessionId);
      this.syncRuntimeFromClient(dbSessionId, client);
    });

    // Hook into idle event to dispatch next queued message
    on('idle', () => {
      if (DEBUG_CHAT_WS) {
        logger.info('[Chat WS] Claude became idle, checking queue', { dbSessionId });
      }
      // Fire and forget - don't await
      void onDispatchNextMessage()
        .catch((error) => {
          logger.error('[Chat WS] Error dispatching queued message on idle', {
            dbSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          // Result events can arrive before the client flips to idle. Re-sync after
          // idle callback to avoid leaving runtime stuck in WORKING.
          // Only mark workspace idle if the client stayed idle after dispatch.
          if (!client.isWorking()) {
            this.workspace.markSessionIdle(context.workspaceId, dbSessionId);
          }
          this.syncRuntimeFromClient(dbSessionId, client);
        });
    });

    on('stream', (event) => {
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
      this.forwardClaudeMessage(dbSessionId, event as ClaudeMessage);
    });

    const registerLoggedDeltaEvent = (
      eventName: string,
      options: {
        debugMessage?: string;
        debugData?: (event: unknown) => Record<string, unknown>;
        mapDelta?: (event: unknown) => unknown;
      } = {}
    ): void => {
      on(eventName, (event) => {
        if (DEBUG_CHAT_WS) {
          logger.info(options.debugMessage ?? `[Chat WS] Received ${eventName} event`, {
            dbSessionId,
            ...(options.debugData?.(event) ?? {}),
          });
        }

        sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
          eventType: eventName,
          data: event,
        });

        sessionDomainService.emitDelta(dbSessionId, options.mapDelta?.(event) ?? event);
      });
    };

    const mappedDeltaEvents: Array<{
      eventName: string;
      debugMessage: string;
      debugData?: (event: unknown) => Record<string, unknown>;
      mapDelta?: (event: unknown) => unknown;
    }> = [
      {
        eventName: 'tool_progress',
        debugMessage: '[Chat WS] Received tool_progress event',
      },
      {
        eventName: 'tool_use_summary',
        debugMessage: '[Chat WS] Received tool_use_summary event',
      },
      {
        eventName: 'system_init',
        debugMessage: '[Chat WS] Received system_init event',
        debugData: (rawEvent) => {
          const event = rawEvent as { tools?: unknown[]; model?: string };
          return {
            tools: event.tools?.length ?? 0,
            model: event.model,
          };
        },
        mapDelta: (rawEvent) => {
          const event = rawEvent as {
            tools?: unknown[];
            model?: string;
            cwd?: string;
            apiKeySource?: string;
            slash_commands?: unknown[];
            plugins?: unknown[];
          };
          return {
            type: 'system_init',
            data: {
              tools: event.tools,
              model: event.model,
              cwd: event.cwd,
              apiKeySource: event.apiKeySource,
              slashCommands: event.slash_commands,
              plugins: event.plugins,
            },
          } as const;
        },
      },
      {
        eventName: 'system_status',
        debugMessage: '[Chat WS] Received system_status event',
        debugData: (rawEvent) => {
          const event = rawEvent as { status?: string; permission_mode?: string };
          return {
            status: event.status,
            permission_mode: event.permission_mode,
          };
        },
        mapDelta: (rawEvent) => {
          const event = rawEvent as { permission_mode?: string };
          return {
            type: 'status_update',
            permissionMode: event.permission_mode,
          } as const;
        },
      },
      {
        eventName: 'hook_started',
        debugMessage: '[Chat WS] Received hook_started event',
        debugData: (rawEvent) => {
          const event = rawEvent as {
            hook_id?: string;
            hook_name?: string;
            hook_event?: string;
          };
          return {
            hookId: event.hook_id,
            hookName: event.hook_name,
            hookEvent: event.hook_event,
          };
        },
        mapDelta: (rawEvent) => {
          const event = rawEvent as {
            hook_id?: string;
            hook_name?: string;
            hook_event?: string;
          };
          return {
            type: 'hook_started',
            data: {
              hookId: event.hook_id,
              hookName: event.hook_name,
              hookEvent: event.hook_event,
            },
          } as const;
        },
      },
      {
        eventName: 'hook_response',
        debugMessage: '[Chat WS] Received hook_response event',
        debugData: (rawEvent) => {
          const event = rawEvent as { hook_id?: string; exit_code?: number; outcome?: string };
          return {
            hookId: event.hook_id,
            exitCode: event.exit_code,
            outcome: event.outcome,
          };
        },
        mapDelta: (rawEvent) => {
          const event = rawEvent as {
            hook_id?: string;
            output?: string;
            stdout?: string;
            stderr?: string;
            exit_code?: number;
            outcome?: string;
          };
          return {
            type: 'hook_response',
            data: {
              hookId: event.hook_id,
              output: event.output,
              stdout: event.stdout,
              stderr: event.stderr,
              exitCode: event.exit_code,
              outcome: event.outcome,
            },
          } as const;
        },
      },
    ];

    for (const eventConfig of mappedDeltaEvents) {
      registerLoggedDeltaEvent(eventConfig.eventName, {
        debugMessage: eventConfig.debugMessage,
        debugData: eventConfig.debugData,
        mapDelta: eventConfig.mapDelta,
      });
    }

    on('compact_boundary', (event) => {
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
      const boundaryMsg = { type: 'compact_boundary' } as const;
      sessionDomainService.emitDelta(dbSessionId, boundaryMsg);
    });

    for (const compactEventName of ['compacting_start', 'compacting_end'] as const) {
      on(compactEventName, () => {
        if (DEBUG_CHAT_WS) {
          logger.info(
            compactEventName === 'compacting_start'
              ? '[Chat WS] Context compaction started'
              : '[Chat WS] Context compaction ended',
            { dbSessionId }
          );
        }
        sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: compactEventName });
        sessionDomainService.emitDelta(dbSessionId, { type: compactEventName } as const);
      });
    }

    on('message', (msg) => {
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'message', data: msg });
      this.handleMessageEvent(dbSessionId, msg, pendingToolNames, pendingToolInputs, context);
    });

    on('result', (result) => {
      if (DEBUG_CHAT_WS) {
        const res = result as { uuid?: string };
        logger.info('[Chat WS] Received result event from client', { dbSessionId, uuid: res.uuid });
      }
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', { eventType: 'result', data: result });
      // Store-then-forward: store events for replay before forwarding
      // Include order for consistent frontend message sorting
      this.forwardClaudeMessage(dbSessionId, result as ClaudeMessage);

      // Mark session as idle
      this.workspace.markSessionIdle(context.workspaceId, dbSessionId);
      this.syncRuntimeFromClient(dbSessionId, client);
    });

    // Forward interactive tool requests (e.g., AskUserQuestion) to frontend
    on('interactive_request', (request) => {
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

      this.routeInteractiveRequest(dbSessionId, request, client);
    });

    on('exit', () => {
      this.removeForwardingListeners(dbSessionId, client);
      this.clientEventSetup.delete(dbSessionId);
      this.lastCompactBoundaryAt.delete(dbSessionId);
      // Queue and pending interactive request are intentionally dropped on process exit.
      // Transcript remains in-memory and is always recoverable from Claude JSONL.
    });

    // Forward request cancellation to frontend (e.g., when CLI cancels during permission or question prompt)
    on('permission_cancelled', (requestId: string) => {
      sessionFileLogger.log(dbSessionId, 'FROM_CLAUDE_CLI', {
        eventType: 'permission_cancelled',
        requestId,
      });
      // Only clear if the requestId matches to avoid race conditions with newer requests
      this.clearPendingRequestIfMatches(dbSessionId, requestId);
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'permission_cancelled',
        requestId,
      });
    });

    on('error', (error) => {
      sessionDomainService.emitDelta(dbSessionId, {
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
    },
    client: ClaudeClient
  ): void {
    if (!isInteractiveResponseTool(request.toolName)) {
      const reason = `Unsupported interactive tool: ${request.toolName}`;
      logger.warn('[Chat WS] Denying unsupported interactive request', {
        dbSessionId,
        requestId: request.requestId,
        toolName: request.toolName,
      });
      try {
        client.denyInteractiveRequest(request.requestId, reason);
      } catch (error) {
        logger.error('[Chat WS] Failed to deny unsupported interactive request', {
          dbSessionId,
          requestId: request.requestId,
          toolName: request.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      sessionDomainService.emitDelta(dbSessionId, {
        type: 'error',
        message: reason,
      });
      return;
    }

    const planContent =
      request.toolName === 'ExitPlanMode' ? this.extractPlanContent(request.input) : null;

    this.routeSupportedInteractiveRequest(
      dbSessionId,
      { ...request, toolName: request.toolName as InteractiveResponseTool },
      planContent,
      client
    );
  }

  private routeSupportedInteractiveRequest(
    dbSessionId: string,
    request: {
      requestId: string;
      toolName: InteractiveResponseTool;
      toolUseId: string;
      input: Record<string, unknown>;
    },
    planContent: string | null,
    client: ClaudeClient
  ): void {
    switch (request.toolName) {
      case 'AskUserQuestion': {
        const parsed = safeParseToolInput(
          AskUserQuestionInputSchema,
          request.input,
          'AskUserQuestion',
          logger
        );

        if (!parsed.success || parsed.data.questions.length === 0) {
          logger.warn('[Chat WS] Invalid or empty AskUserQuestion input', {
            dbSessionId,
            requestId: request.requestId,
            validationSuccess: parsed.success,
          });
          try {
            client.denyInteractiveRequest(
              request.requestId,
              'Invalid question format - unable to display question'
            );
          } catch (error) {
            logger.error('[Chat WS] Failed to deny invalid AskUserQuestion request', {
              dbSessionId,
              requestId: request.requestId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          sessionDomainService.emitDelta(dbSessionId, {
            type: 'error',
            message: 'Received invalid question format from CLI',
          });
          return;
        }

        this.storePendingInteractiveRequest(dbSessionId, request, planContent);

        sessionDomainService.emitDelta(dbSessionId, {
          type: 'user_question',
          requestId: request.requestId,
          questions: parsed.data.questions,
        });
        return;
      }
      case 'ExitPlanMode':
        this.storePendingInteractiveRequest(dbSessionId, request, planContent);
        sessionDomainService.emitDelta(dbSessionId, {
          type: 'permission_request',
          requestId: request.requestId,
          toolName: request.toolName,
          toolInput: request.input,
          planContent,
        });
        return;
      default: {
        const unreachable: never = request.toolName;
        logger.error('[Chat WS] Unhandled interactive response tool', {
          dbSessionId,
          requestId: request.requestId,
          toolName: unreachable,
        });
      }
    }
  }

  private storePendingInteractiveRequest(
    dbSessionId: string,
    request: {
      requestId: string;
      toolName: InteractiveResponseTool;
      toolUseId: string;
      input: Record<string, unknown>;
    },
    planContent: string | null
  ): void {
    sessionDomainService.setPendingInteractiveRequest(dbSessionId, {
      requestId: request.requestId,
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      input: request.input,
      planContent,
      timestamp: new Date().toISOString(),
    });
  }

  private handleMessageEvent(
    dbSessionId: string,
    msg: unknown,
    pendingToolNames: Map<string, string>,
    pendingToolInputs: Map<string, Record<string, unknown>>,
    context: EventForwarderContext
  ): void {
    const msgWithType = msg as {
      type?: string;
      uuid?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };

    if (msgWithType.type === 'assistant') {
      this.forwardAssistantTextMessage(dbSessionId, msg, msgWithType);
      return;
    }

    if (msgWithType.type !== 'user') {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'not_user_type',
        type: msgWithType.type,
      });
      return;
    }

    this.forwardUserMessageWithToolResult(
      dbSessionId,
      msg,
      msgWithType,
      pendingToolNames,
      pendingToolInputs,
      context
    );
  }

  private forwardAssistantTextMessage(
    dbSessionId: string,
    msg: unknown,
    msgWithType: {
      message?: { content?: Array<{ type?: string; text?: string }> };
    }
  ): void {
    const assistantMsg = msg as ClaudeMessage;
    const fallbackToolUseEvents = this.buildToolUseFallbackStreamEvents(assistantMsg);
    for (const toolUseEvent of fallbackToolUseEvents) {
      this.forwardClaudeMessage(dbSessionId, toolUseEvent);
    }

    const content = msgWithType.message?.content;
    if (!Array.isArray(content)) {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'assistant_no_array_content',
      });
      return;
    }

    const hasNarrativeText = content.some(
      (item) => item.type === 'text' && typeof item.text === 'string'
    );
    if (!hasNarrativeText) {
      sessionFileLogger.log(dbSessionId, 'INFO', {
        action: 'skipped_message',
        reason: 'assistant_no_text_content',
      });
      return;
    }

    // Persist only narrative text from assistant message events.
    const normalized = this.normalizeAssistantMessageToTextOnly(assistantMsg);
    if (!normalized) {
      return;
    }
    this.forwardClaudeMessage(dbSessionId, normalized);
  }

  private buildToolUseFallbackStreamEvents(message: ClaudeMessage): ClaudeMessage[] {
    if (message.type !== 'assistant') {
      return [];
    }
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return [];
    }

    const fallbackEvents: ClaudeMessage[] = [];
    for (const [index, item] of content.entries()) {
      if (item.type !== 'tool_use') {
        continue;
      }
      fallbackEvents.push({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index,
          content_block: item,
        },
        timestamp: message.timestamp ?? new Date().toISOString(),
      });
    }

    return fallbackEvents;
  }

  private normalizeAssistantMessageToTextOnly(message: ClaudeMessage): ClaudeMessage | null {
    if (message.type !== 'assistant') {
      return null;
    }
    const content = message.message?.content;
    if (!Array.isArray(content)) {
      return null;
    }

    const textBlocks = content.filter(
      (item): item is ClaudeContentItem & { type: 'text'; text: string } =>
        item.type === 'text' && typeof item.text === 'string'
    );

    if (textBlocks.length === 0) {
      return null;
    }

    return {
      ...message,
      message: {
        role: 'assistant',
        content: textBlocks,
      },
    };
  }

  private forwardUserMessageWithToolResult(
    dbSessionId: string,
    msg: unknown,
    msgWithType: {
      uuid?: string;
      message?: { content?: Array<{ type?: string }> };
    },
    pendingToolNames: Map<string, string>,
    pendingToolInputs: Map<string, Record<string, unknown>>,
    context: EventForwarderContext
  ): void {
    // Forward user message UUID for rewind functionality.
    if (msgWithType.uuid) {
      const uuidMsg = { type: 'user_message_uuid', uuid: msgWithType.uuid } as const;
      sessionDomainService.emitDelta(dbSessionId, uuidMsg);
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

    const hasToolResult = hasToolResultContent(content as ClaudeContentItem[]);
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

    this.forwardClaudeMessage(dbSessionId, msg as ClaudeMessage);
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
   * Get all pending interactive requests indexed by session ID.
   * Used by workspace query service to determine which workspaces have pending requests.
   */
  getAllPendingRequests(): Map<string, PendingInteractiveRequest> {
    return sessionDomainService.getAllPendingRequests();
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

  private syncRuntimeFromClient(dbSessionId: string, client: ClaudeClient): void {
    if (client.isWorking()) {
      sessionDomainService.markRunning(dbSessionId);
      return;
    }
    sessionDomainService.markIdle(dbSessionId, client.isRunning() ? 'alive' : 'stopped');
  }
}

export const chatEventForwarderService = new ChatEventForwarderService();
