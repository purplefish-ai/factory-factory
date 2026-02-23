import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type {
  AcpClientOptions,
  AcpProcessHandle,
  AcpRuntimeManager,
} from '@/backend/domains/session/acp';
import {
  AcpEventTranslator,
  type AcpRuntimeEventHandlers,
  acpRuntimeManager,
} from '@/backend/domains/session/acp';
import type { SessionWorkspaceBridge } from '@/backend/domains/session/bridges';
import { acpTraceLogger } from '@/backend/domains/session/logging/acp-trace-logger.service';
import { sessionFileLogger } from '@/backend/domains/session/logging/session-file-logger.service';
import {
  type SessionDomainService,
  sessionDomainService,
} from '@/backend/domains/session/session-domain.service';
import { interceptorRegistry } from '@/backend/interceptors/registry';
import type { InterceptorContext, ToolEvent } from '@/backend/interceptors/types';
import type { AgentSessionRecord } from '@/backend/resource_accessors/agent-session.accessor';
import { createLogger } from '@/backend/services/logger.service';
import type {
  AgentContentItem,
  AgentMessage,
  ChatMessage,
  HistoryMessage,
  SessionDeltaEvent,
} from '@/shared/acp-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { SessionStatus } from '@/shared/core';
import {
  createInitialSessionRuntimeState,
  type SessionRuntimeState,
} from '@/shared/session-runtime';
import {
  type PersistAcpConfigSnapshotParams,
  SessionConfigService,
} from './session.config.service';
import { SessionPermissionService } from './session.permission.service';
import type { SessionPromptBuilder } from './session.prompt-builder';
import { sessionPromptBuilder } from './session.prompt-builder';
import type { SessionRepository } from './session.repository';
import { sessionRepository } from './session.repository';

const logger = createLogger('session');
const STALE_LOADING_RUNTIME_MAX_AGE_MS = 30_000;
type SessionPermissionMode = 'bypassPermissions' | 'plan';
type SessionStartupModePreset = 'non_interactive' | 'plan';
type PromptTurnCompleteHandler = (sessionId: string) => Promise<void> | void;
type PendingAcpToolCall = {
  toolUseId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  acpKind?: string;
  acpLocations?: Array<{ path: string; line?: number | null }>;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object') {
    return JSON.stringify(error);
  }
  return String(error);
}

export type SessionServiceDependencies = {
  repository?: SessionRepository;
  promptBuilder?: SessionPromptBuilder;
  runtimeManager?: AcpRuntimeManager;
  sessionDomainService?: SessionDomainService;
};

export class SessionService {
  private readonly repository: SessionRepository;
  private readonly promptBuilder: SessionPromptBuilder;
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private readonly acpEventTranslator = new AcpEventTranslator(logger);
  private readonly sessionPermissionService: SessionPermissionService;
  private readonly sessionConfigService: SessionConfigService;
  /** Per-session text accumulation state for ACP streaming (reuses order so frontend upserts). */
  private readonly acpStreamState = new Map<string, { textOrder: number; accText: string }>();
  /** Per-session ACP tool calls that have started but not yet been completed by tool_result. */
  private readonly pendingAcpToolCalls = new Map<string, Map<string, PendingAcpToolCall>>();
  /**
   * Suppress transcript-mutating ACP replay events for sessions whose transcript was
   * already hydrated from on-disk history during passive load_session.
   */
  private readonly suppressAcpReplayForSession = new Set<string>();
  /** Cross-domain bridge for workspace activity (injected by orchestration layer) */
  private workspaceBridge: SessionWorkspaceBridge | null = null;
  /** Maps sessionId → workspaceId for bridge calls during sendAcpMessage */
  private readonly sessionToWorkspace = new Map<string, string>();
  /** Maps sessionId → workingDir for interceptor context */
  private readonly sessionToWorkingDir = new Map<string, string>();
  /** Optional callback invoked after an ACP prompt turn settles. */
  private promptTurnCompleteHandler: PromptTurnCompleteHandler | null = null;

  /**
   * Configure cross-domain bridges. Called once at startup by orchestration layer.
   */
  configure(bridges: {
    workspace: Pick<SessionWorkspaceBridge, 'markSessionRunning' | 'markSessionIdle'>;
  }): void {
    this.workspaceBridge = bridges.workspace as SessionWorkspaceBridge;
  }

  setPromptTurnCompleteHandler(handler: PromptTurnCompleteHandler | null): void {
    this.promptTurnCompleteHandler = handler;
  }

  private isStaleLoadingRuntime(runtime: SessionRuntimeState): boolean {
    if (runtime.phase !== 'loading' || runtime.processState === 'alive') {
      return false;
    }

    const updatedAtMs = Date.parse(runtime.updatedAt);
    if (Number.isNaN(updatedAtMs)) {
      return false;
    }

    return Date.now() - updatedAtMs > STALE_LOADING_RUNTIME_MAX_AGE_MS;
  }

  private setupAcpEventHandler(sessionId: string): AcpRuntimeEventHandlers {
    const permissionBridge = this.sessionPermissionService.createPermissionBridge(sessionId);

    return {
      permissionBridge,
      onAcpEvent: (sid: string, event: unknown) => {
        const typed = event as { type: string };

        if (typed.type === 'acp_session_update') {
          const { update } = event as {
            type: string;
            update: import('@agentclientprotocol/sdk').SessionUpdate;
          };
          if (update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text') {
            this.handleAcpUserMessageChunk(sid, update.content.text);
            return;
          }
          const deltas = this.acpEventTranslator.translateSessionUpdate(update);
          if (deltas.length === 0) {
            acpTraceLogger.log(sid, 'translated_delta', {
              sessionUpdate: update.sessionUpdate,
              deltaCount: 0,
            });
          }
          for (const [index, delta] of deltas.entries()) {
            acpTraceLogger.log(sid, 'translated_delta', {
              sessionUpdate: update.sessionUpdate,
              deltaIndex: index,
              delta,
            });
            this.handleAcpDelta(sid, delta as SessionDeltaEvent);
          }
          return;
        }

        if (typed.type === 'acp_permission_request') {
          this.sessionPermissionService.handlePermissionRequest(sid, event);
          return;
        }
      },
      onSessionId: async (sid: string, providerSessionId: string) => {
        try {
          await this.repository.updateSession(sid, { providerSessionId });
          acpTraceLogger.log(sid, 'runtime_metadata', {
            type: 'provider_session_id',
            providerSessionId,
          });
          logger.debug('Updated session with ACP providerSessionId', {
            sessionId: sid,
            providerSessionId,
          });
        } catch (error) {
          logger.warn('Failed to update session with ACP providerSessionId', {
            sessionId: sid,
            providerSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      onExit: async (sid: string, exitCode: number | null) => {
        // Clean up permission bridge, streaming state, and workspace mapping on exit
        this.acpStreamState.delete(sid);
        this.pendingAcpToolCalls.delete(sid);
        this.suppressAcpReplayForSession.delete(sid);
        this.sessionToWorkspace.delete(sid);
        this.sessionToWorkingDir.delete(sid);
        this.sessionPermissionService.cancelPendingRequests(sid);
        acpTraceLogger.log(sid, 'runtime_exit', { exitCode });

        try {
          this.sessionDomainService.markProcessExit(sid, exitCode);
          const session = await this.repository.updateSession(sid, {
            status: SessionStatus.COMPLETED,
          });
          logger.debug('Updated ACP session status to COMPLETED on exit', { sessionId: sid });

          await this.repository.clearRatchetActiveSession(session.workspaceId, sid);
          if (session.workflow === 'ratchet') {
            await this.repository.deleteSession(sid);
            logger.debug('Deleted transient ratchet ACP session', { sessionId: sid });
          }
        } catch (error) {
          logger.warn('Failed to update ACP session status on exit', {
            sessionId: sid,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          acpTraceLogger.closeSession(sid);
        }
      },
      onError: (sid: string, error: Error) => {
        acpTraceLogger.log(sid, 'runtime_error', {
          message: error.message,
          stack: error.stack,
        });
        this.sessionDomainService.markError(sid, error.message);
        logger.error('ACP client error', {
          sessionId: sid,
          error: error.message,
          stack: error.stack,
        });
      },
      onAcpLog: (sid: string, payload: Record<string, unknown>) => {
        acpTraceLogger.log(sid, 'raw_acp_event', payload);
        sessionFileLogger.log(sid, 'FROM_CLAUDE_CLI', payload);
      },
    };
  }

  /**
   * Handle a single translated ACP delta: persist and emit agent_messages,
   * accumulate text chunks, and forward non-message deltas.
   */
  private handleAcpDelta(sid: string, delta: SessionDeltaEvent): void {
    this.maybeLiftReplaySuppression(sid);

    if (
      this.suppressAcpReplayForSession.has(sid) &&
      delta.type !== 'config_options_update' &&
      delta.type !== 'slash_commands'
    ) {
      return;
    }

    this.trackPendingAcpToolCalls(sid, delta);

    // When configOptions change mid-session, sync the handle and re-emit capabilities
    if (delta.type === 'config_options_update') {
      const acpHandle = this.runtimeManager.getClient(sid);
      if (acpHandle) {
        const { configOptions } = delta as { configOptions: unknown[] };
        this.sessionConfigService.applyConfigOptionsUpdateDelta(
          sid,
          acpHandle,
          configOptions as SessionConfigOption[]
        );
        return;
      }
    }

    if (delta.type !== 'agent_message') {
      this.sessionDomainService.emitDelta(sid, delta);
      return;
    }

    const data = (delta as { data: AgentMessage }).data;

    // Text chunks: accumulate into single message, reuse same order
    // so the frontend upserts rather than inserting a new bubble per chunk.
    if (data.type === 'assistant') {
      this.accumulateAcpText(sid, data);
      return;
    }

    // Non-text agent_message (thinking, tool_use, result): reset text accumulator
    this.acpStreamState.delete(sid);
    // Persist to transcript + allocate order in one step
    const order = this.sessionDomainService.appendClaudeEvent(sid, data);
    this.sessionDomainService.emitDelta(sid, { ...delta, order });
  }

  private trackPendingAcpToolCalls(sid: string, delta: SessionDeltaEvent): void {
    if (delta.type === 'agent_message') {
      this.trackPendingFromAgentMessage(sid, (delta as { data: AgentMessage }).data);
      return;
    }

    if (delta.type === 'tool_progress') {
      this.trackPendingFromToolProgress(
        sid,
        delta as {
          tool_use_id?: string;
          tool_name?: string;
          acpStatus?: string;
          acpKind?: string;
          acpLocations?: Array<{ path: string; line?: number | null }>;
        }
      );
    }
  }

  private trackPendingFromAgentMessage(sid: string, data: AgentMessage): void {
    if (data.type === 'stream_event') {
      this.trackPendingFromToolUseStreamEvent(sid, data);
    }

    if (data.type !== 'user') {
      return;
    }

    this.clearPendingFromToolResultMessage(sid, data);
  }

  private trackPendingFromToolUseStreamEvent(sid: string, data: AgentMessage): void {
    const streamEvent = (
      data as {
        event?: {
          type?: string;
          content_block?: { type?: string; id?: unknown; name?: unknown; input?: unknown };
        };
      }
    ).event;
    const contentBlock = streamEvent?.content_block;
    const isToolUse =
      streamEvent?.type === 'content_block_start' && contentBlock?.type === 'tool_use';
    if (!isToolUse) {
      return;
    }
    const toolUseId = typeof contentBlock?.id === 'string' ? contentBlock.id : null;
    if (!toolUseId) {
      return;
    }
    const toolName = typeof contentBlock?.name === 'string' ? contentBlock.name : 'ACP Tool';
    const toolInput = this.normalizeToolInput(contentBlock?.input);
    const existing = this.getPendingToolCall(sid, toolUseId);
    this.upsertPendingToolCall(sid, toolUseId, { toolName, toolInput });
    if (!existing) {
      this.notifyInterceptorToolStart(sid, {
        toolUseId,
        toolName,
        toolInput: toolInput ?? {},
      });
    }
  }

  private clearPendingFromToolResultMessage(sid: string, data: AgentMessage): void {
    if (data.type !== 'user') {
      return;
    }
    const content = data.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const item of content) {
      if (item.type === 'tool_result') {
        const pending = this.getPendingToolCall(sid, item.tool_use_id);
        this.notifyInterceptorToolComplete(
          sid,
          item.tool_use_id,
          item.content,
          item.is_error === true,
          pending
        );
        this.removePendingToolCall(sid, item.tool_use_id);
      }
    }
  }

  private trackPendingFromToolProgress(
    sid: string,
    progress: {
      tool_use_id?: string;
      tool_name?: string;
      acpStatus?: string;
      acpKind?: string;
      acpLocations?: Array<{ path: string; line?: number | null }>;
    }
  ): void {
    if (!progress.tool_use_id) {
      return;
    }
    // ACP translator emits terminal tool_progress before tool_result in the same batch.
    // Keep pending metadata here and clear only after processing tool_result.
    const existing = this.getPendingToolCall(sid, progress.tool_use_id);
    this.upsertPendingToolCall(sid, progress.tool_use_id, {
      toolName: progress.tool_name ?? 'ACP Tool',
      acpKind: progress.acpKind,
      acpLocations: progress.acpLocations,
    });
    if (!existing) {
      this.notifyInterceptorToolStart(sid, {
        toolUseId: progress.tool_use_id,
        toolName: progress.tool_name ?? 'ACP Tool',
        toolInput: {},
      });
    }
  }

  private upsertPendingToolCall(
    sid: string,
    toolUseId: string,
    update: Pick<PendingAcpToolCall, 'toolName'> &
      Partial<Pick<PendingAcpToolCall, 'toolInput' | 'acpKind' | 'acpLocations'>>
  ): void {
    const pendingById = this.pendingAcpToolCalls.get(sid) ?? new Map<string, PendingAcpToolCall>();
    const existing = pendingById.get(toolUseId);
    pendingById.set(toolUseId, {
      toolUseId,
      toolName: update.toolName || existing?.toolName || 'ACP Tool',
      toolInput: update.toolInput ?? existing?.toolInput,
      acpKind: update.acpKind ?? existing?.acpKind,
      acpLocations: update.acpLocations ?? existing?.acpLocations,
    });
    this.pendingAcpToolCalls.set(sid, pendingById);
  }

  private getPendingToolCall(sid: string, toolUseId: string): PendingAcpToolCall | undefined {
    return this.pendingAcpToolCalls.get(sid)?.get(toolUseId);
  }

  private removePendingToolCall(sid: string, toolUseId: string): void {
    const pendingById = this.pendingAcpToolCalls.get(sid);
    if (!pendingById) {
      return;
    }
    pendingById.delete(toolUseId);
    if (pendingById.size === 0) {
      this.pendingAcpToolCalls.delete(sid);
    }
  }

  private normalizeToolInput(input: unknown): Record<string, unknown> | undefined {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return undefined;
    }
    return input as Record<string, unknown>;
  }

  private extractToolResultText(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .flatMap((item) => {
          if (
            typeof item === 'object' &&
            item !== null &&
            (item as { type?: unknown }).type === 'text' &&
            typeof (item as { text?: unknown }).text === 'string'
          ) {
            return [(item as { text: string }).text];
          }
          return [];
        })
        .join('\n');
    }

    if (content === undefined || content === null) {
      return '';
    }

    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  private getInterceptorContext(sessionId: string): InterceptorContext | null {
    const workspaceId = this.sessionToWorkspace.get(sessionId);
    const workingDir = this.sessionToWorkingDir.get(sessionId);
    if (!(workspaceId && workingDir)) {
      return null;
    }

    return {
      sessionId,
      workspaceId,
      workingDir,
      timestamp: new Date(),
    };
  }

  private notifyInterceptorToolStart(
    sessionId: string,
    tool: Pick<PendingAcpToolCall, 'toolUseId' | 'toolName'> & {
      toolInput: Record<string, unknown>;
    }
  ): void {
    const context = this.getInterceptorContext(sessionId);
    if (!context) {
      return;
    }

    const event: ToolEvent = {
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      input: tool.toolInput,
    };
    interceptorRegistry.notifyToolStart(event, context);
  }

  private notifyInterceptorToolComplete(
    sessionId: string,
    toolUseId: string,
    content: unknown,
    isError: boolean,
    pending: PendingAcpToolCall | undefined
  ): void {
    const context = this.getInterceptorContext(sessionId);
    if (!context) {
      return;
    }

    const event: ToolEvent = {
      toolUseId,
      toolName: pending?.toolName ?? 'ACP Tool',
      input: pending?.toolInput ?? {},
      output: {
        content: this.extractToolResultText(content),
        isError,
      },
    };
    interceptorRegistry.notifyToolComplete(event, context);
  }

  private finalizeOrphanedToolCalls(sid: string, reason: string): void {
    const pendingById = this.pendingAcpToolCalls.get(sid);
    if (!pendingById || pendingById.size === 0) {
      this.pendingAcpToolCalls.delete(sid);
      return;
    }

    const toolUseIds = [...pendingById.keys()];
    logger.warn('Finalizing orphaned ACP tool calls without terminal status', {
      sessionId: sid,
      reason,
      count: toolUseIds.length,
      toolUseIds,
    });

    for (const pending of pendingById.values()) {
      const syntheticProgress = {
        type: 'tool_progress',
        tool_use_id: pending.toolUseId,
        tool_name: pending.toolName,
        acpStatus: 'failed',
        elapsed_time_seconds: 0,
        ...(pending.acpKind ? { acpKind: pending.acpKind } : {}),
        ...(pending.acpLocations ? { acpLocations: pending.acpLocations } : {}),
      } as SessionDeltaEvent;
      this.handleAcpDelta(sid, syntheticProgress);

      const syntheticResult = {
        type: 'agent_message',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: pending.toolUseId,
                content: `Tool call did not receive a terminal ACP update (${reason}). Marked as failed locally.`,
                is_error: true,
              },
            ],
          },
        },
      } as SessionDeltaEvent;
      this.handleAcpDelta(sid, syntheticResult);

      acpTraceLogger.log(sid, 'translated_delta', {
        sessionUpdate: 'synthetic_orphan_tool_call',
        delta: syntheticProgress,
      });
      acpTraceLogger.log(sid, 'translated_delta', {
        sessionUpdate: 'synthetic_orphan_tool_call',
        delta: syntheticResult,
      });
    }

    this.pendingAcpToolCalls.delete(sid);
  }

  /**
   * ACP can emit user_message_chunk during both replay (idle) and live sends (working).
   * Live sends are already committed by our send pipeline, so only inject replay chunks.
   */
  private handleAcpUserMessageChunk(sid: string, text: string): void {
    this.maybeLiftReplaySuppression(sid);
    if (this.suppressAcpReplayForSession.has(sid)) {
      return;
    }
    if (this.runtimeManager.isSessionWorking(sid)) {
      return;
    }
    const normalized = text.trim();
    if (normalized.length === 0) {
      return;
    }
    this.sessionDomainService.injectCommittedUserMessage(sid, normalized);
  }

  /**
   * Accumulate ACP assistant text chunks into a single message at a stable order.
   */
  private accumulateAcpText(sid: string, data: AgentMessage): void {
    const content = data.message?.content;
    const chunkText =
      Array.isArray(content) && content[0]?.type === 'text'
        ? (content[0] as { text: string }).text
        : '';
    let ss = this.acpStreamState.get(sid);
    if (!ss) {
      ss = { textOrder: this.sessionDomainService.allocateOrder(sid), accText: '' };
      this.acpStreamState.set(sid, ss);
    }
    ss.accText += chunkText;
    const accMsg: AgentMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: ss.accText }] },
    };
    this.sessionDomainService.upsertClaudeEvent(sid, accMsg, ss.textOrder);
    this.sessionDomainService.emitDelta(sid, {
      type: 'agent_message',
      data: accMsg,
      order: ss.textOrder,
    } as SessionDeltaEvent & { order: number });
  }

  private async createAcpClient(
    sessionId: string,
    options?: {
      model?: string;
      permissionMode?: SessionPermissionMode;
    },
    session?: AgentSessionRecord
  ): Promise<AcpProcessHandle> {
    const sessionContext = await this.loadSessionContext(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session context not ready: ${sessionId}`);
    }

    await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
    this.sessionToWorkspace.set(sessionId, sessionContext.workspaceId);
    this.sessionToWorkingDir.set(sessionId, sessionContext.workingDir);

    const handlers = this.setupAcpEventHandler(sessionId);
    const shouldSuppressReplay = this.shouldSuppressReplayDuringAcpResume(sessionId, session);
    if (shouldSuppressReplay) {
      this.suppressAcpReplayForSession.add(sessionId);
    } else {
      this.suppressAcpReplayForSession.delete(sessionId);
    }

    const clientOptions: AcpClientOptions = {
      provider: session?.provider ?? 'CLAUDE',
      workingDir: sessionContext.workingDir,
      model: options?.model ?? sessionContext.model,
      systemPrompt: sessionContext.systemPrompt,
      permissionMode: options?.permissionMode ?? 'bypassPermissions',
      sessionId,
      resumeProviderSessionId: session?.providerSessionId ?? undefined,
    };

    let handle: AcpProcessHandle;
    try {
      handle = await this.runtimeManager.getOrCreateClient(sessionId, clientOptions, handlers, {
        workspaceId: sessionContext.workspaceId,
        workingDir: sessionContext.workingDir,
      });
    } catch (error) {
      this.suppressAcpReplayForSession.delete(sessionId);
      this.sessionToWorkspace.delete(sessionId);
      this.sessionToWorkingDir.delete(sessionId);
      throw error;
    }

    await this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as PersistAcpConfigSnapshotParams['provider'],
      providerSessionId: handle.providerSessionId,
      configOptions: handle.configOptions,
      existingMetadata: session?.providerMetadata ?? undefined,
    });

    // Emit initial config options so the frontend receives them on session start
    if (handle.configOptions.length > 0) {
      this.sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions: handle.configOptions,
      } as SessionDeltaEvent);
    }

    // Re-emit chat_capabilities now that the ACP handle exists.
    // The initial load_session fires before the handle is ready, so the
    // frontend would otherwise be stuck with EMPTY capabilities.
    this.sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: this.buildAcpChatBarCapabilities(handle),
    });

    return handle;
  }

  private shouldSuppressReplayDuringAcpResume(
    sessionId: string,
    session: AgentSessionRecord | undefined
  ): boolean {
    if (!session?.providerSessionId) {
      return false;
    }

    if (!this.sessionDomainService.isHistoryHydrated(sessionId)) {
      return false;
    }

    return this.sessionDomainService.getTranscriptSnapshot(sessionId).length > 0;
  }

  private maybeLiftReplaySuppression(sessionId: string): void {
    if (!this.suppressAcpReplayForSession.has(sessionId)) {
      return;
    }
    if (!this.runtimeManager.isSessionWorking(sessionId)) {
      return;
    }
    this.suppressAcpReplayForSession.delete(sessionId);
  }

  constructor(options?: SessionServiceDependencies) {
    this.repository = options?.repository ?? sessionRepository;
    this.promptBuilder = options?.promptBuilder ?? sessionPromptBuilder;
    this.runtimeManager = options?.runtimeManager ?? acpRuntimeManager;
    this.sessionDomainService = options?.sessionDomainService ?? sessionDomainService;
    this.sessionPermissionService = new SessionPermissionService({
      sessionDomainService: this.sessionDomainService,
    });
    this.sessionConfigService = new SessionConfigService({
      repository: this.repository,
      runtimeManager: this.runtimeManager,
      sessionDomainService: this.sessionDomainService,
    });
  }

  /**
   * Start a session using the ACP runtime.
   */
  async startSession(
    sessionId: string,
    options?: {
      initialPrompt?: string;
      startupModePreset?: SessionStartupModePreset;
    }
  ): Promise<void> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (this.runtimeManager.isStopInProgress(sessionId)) {
      throw new Error('Session is currently being stopped');
    }

    // Check if session is already running to prevent duplicate message sends
    const existingClient = this.runtimeManager.getClient(sessionId);
    if (existingClient) {
      throw new Error('Session is already running');
    }

    // Use getOrCreate for race-protected creation
    const startupModePreset = options?.startupModePreset;
    const startupPermissionMode: SessionPermissionMode =
      startupModePreset === 'plan' ? 'plan' : 'bypassPermissions';

    const handle = await this.getOrCreateAcpSessionClient(
      sessionId,
      { permissionMode: startupPermissionMode },
      session
    );
    await this.applyStartupModePreset(sessionId, handle, startupModePreset, session.workflow);
    if (!session.providerSessionId) {
      await this.applyConfiguredPermissionPreset(sessionId, session, handle);
    }

    // Send initial prompt - defaults to 'Continue with the task.' if not provided
    const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
    if (initialPrompt) {
      await this.sendSessionMessage(sessionId, initialPrompt);
    }

    logger.info('Session started', { sessionId, provider: session.provider });
  }

  private async applyStartupModePreset(
    sessionId: string,
    handle: AcpProcessHandle,
    startupModePreset: SessionStartupModePreset | undefined,
    workflow: string
  ): Promise<void> {
    await this.sessionConfigService.applyStartupModePreset(
      sessionId,
      handle,
      startupModePreset,
      workflow,
      {
        persistSnapshot: this.persistAcpConfigSnapshot.bind(this),
      }
    );
  }

  private async applyConfiguredPermissionPreset(
    sessionId: string,
    session: AgentSessionRecord,
    handle: AcpProcessHandle
  ): Promise<void> {
    await this.sessionConfigService.applyConfiguredPermissionPreset(sessionId, session, handle);
  }

  /**
   * Stop a session gracefully via the ACP runtime.
   */
  async stopSession(
    sessionId: string,
    options?: { cleanupTransientRatchetSession?: boolean }
  ): Promise<void> {
    const session = await this.loadSessionForStop(sessionId);
    const workspaceId = session?.workspaceId ?? this.sessionToWorkspace.get(sessionId);

    if (this.runtimeManager.isStopInProgress(sessionId)) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
    }

    const current = this.getRuntimeSnapshot(sessionId);
    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      ...current,
      phase: 'stopping',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    // Cancel pending ACP permissions and clean up streaming state
    this.acpStreamState.delete(sessionId);
    this.suppressAcpReplayForSession.delete(sessionId);
    this.sessionPermissionService.cancelPendingRequests(sessionId);

    let stopClientFailed = false;
    try {
      if (!this.runtimeManager.isStopInProgress(sessionId)) {
        await this.runtimeManager.stopClient(sessionId);
      }
    } catch (error) {
      stopClientFailed = true;
      logger.warn('Error stopping ACP session runtime; continuing cleanup', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.finalizeOrphanedToolCallsOnStop(sessionId);
      await this.updateStoppedSessionState(sessionId);
      // Manual stop should clear queued work and publish that change immediately
      // so clients do not retain stale queued-message UI.
      this.sessionDomainService.clearQueuedWork(sessionId, { emitSnapshot: true });
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      this.markWorkspaceSessionIdleOnStop(workspaceId, sessionId);
      this.sessionToWorkspace.delete(sessionId);
      this.sessionToWorkingDir.delete(sessionId);

      if (!stopClientFailed) {
        const shouldCleanupTransientRatchetSession =
          options?.cleanupTransientRatchetSession ?? true;
        await this.cleanupTransientRatchetOnStop(
          session,
          sessionId,
          shouldCleanupTransientRatchetSession
        );
      }

      logger.info('ACP session stopped', {
        sessionId,
        ...(stopClientFailed ? { runtimeStopFailed: true } : {}),
      });
      acpTraceLogger.closeSession(sessionId);
    }
  }

  private finalizeOrphanedToolCallsOnStop(sessionId: string): void {
    try {
      this.finalizeOrphanedToolCalls(sessionId, 'session_stop');
    } catch (error) {
      logger.warn('Failed finalizing orphaned ACP tool calls during stop', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.pendingAcpToolCalls.delete(sessionId);
    }
  }

  private markWorkspaceSessionIdleOnStop(workspaceId: string | undefined, sessionId: string): void {
    if (!(workspaceId && this.workspaceBridge)) {
      return;
    }

    try {
      this.workspaceBridge.markSessionIdle(workspaceId, sessionId);
    } catch (error) {
      logger.warn('Failed to mark workspace session idle during stop', {
        sessionId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async loadSessionForStop(sessionId: string): Promise<AgentSessionRecord | null> {
    try {
      return await this.repository.getSessionById(sessionId);
    } catch (error) {
      logger.warn('Failed to load session before stop; continuing with process shutdown', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async updateStoppedSessionState(sessionId: string): Promise<void> {
    try {
      await this.repository.updateSession(sessionId, {
        status: SessionStatus.IDLE,
      });
    } catch (error) {
      logger.warn('Failed to update session state during stop; continuing cleanup', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async cleanupTransientRatchetOnStop(
    session: AgentSessionRecord | null,
    sessionId: string,
    shouldCleanupTransientRatchetSession: boolean
  ): Promise<void> {
    // Ratchet sessions should always clear active pointer on stop.
    if (session?.workflow !== 'ratchet') {
      return;
    }

    try {
      await this.repository.clearRatchetActiveSession(session.workspaceId, sessionId);
    } catch (error) {
      logger.warn('Failed clearing ratchet active session pointer during stop', {
        sessionId,
        workspaceId: session.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Session row deletion is optional so callers (e.g. explicit delete endpoint)
    // can avoid double-delete races while still clearing the active pointer.
    if (!shouldCleanupTransientRatchetSession) {
      return;
    }

    try {
      await this.repository.deleteSession(sessionId);
      logger.debug('Deleted transient ratchet session after stop', { sessionId });
    } catch (error) {
      logger.warn('Failed deleting transient ratchet session during stop', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stop all Claude sessions for a workspace
   */
  async stopWorkspaceSessions(workspaceId: string): Promise<void> {
    const sessions = await this.repository.getSessionsByWorkspaceId(workspaceId);

    for (const session of sessions) {
      if (
        session.status === SessionStatus.RUNNING ||
        this.runtimeManager.isSessionRunning(session.id)
      ) {
        try {
          await this.stopSession(session.id);
        } catch (error) {
          logger.error('Failed to stop workspace session', {
            sessionId: session.id,
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    logger.info('Stopped all workspace sessions', { workspaceId, count: sessions.length });
  }

  // ===========================================================================
  // Client Lifecycle (Single Source of Truth)
  // ===========================================================================

  /**
   * Get or create a provider client for a session.
   * This is the single source of truth for runtime client lifecycle management.
   */
  async getOrCreateSessionClient(
    sessionId: string,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: SessionPermissionMode;
      model?: string;
      reasoningEffort?: string;
    }
  ): Promise<unknown> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const hadClient = !!this.runtimeManager.getClient(sessionId);
    const handle = await this.getOrCreateAcpSessionClient(sessionId, options ?? {}, session);
    if (!(hadClient || session.providerSessionId)) {
      await this.applyConfiguredPermissionPreset(sessionId, session, handle);
    }

    return handle;
  }

  /**
   * Reuses a preloaded session record to avoid redundant lookups and reduce
   * races between separate reads during load_session initialization.
   */
  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: SessionPermissionMode;
      model?: string;
      reasoningEffort?: string;
    }
  ): Promise<unknown> {
    const hadClient = !!this.runtimeManager.getClient(session.id);
    const handle = await this.getOrCreateAcpSessionClient(session.id, options ?? {}, session);
    if (!(hadClient || session.providerSessionId)) {
      await this.applyConfiguredPermissionPreset(session.id, session, handle);
    }

    return handle;
  }

  getSessionClient(sessionId: string): unknown | undefined {
    return this.runtimeManager.getClient(sessionId);
  }

  getSessionConfigOptions(sessionId: string): SessionConfigOption[] {
    return this.sessionConfigService.getSessionConfigOptions(sessionId);
  }

  getSessionConfigOptionsWithFallback(sessionId: string): Promise<SessionConfigOption[]> {
    return this.sessionConfigService.getSessionConfigOptionsWithFallback(sessionId);
  }

  async setSessionModel(sessionId: string, model?: string): Promise<void> {
    await this.sessionConfigService.setSessionModel(sessionId, model);
  }

  setSessionReasoningEffort(sessionId: string, _effort: string | null): void {
    // ACP sessions do not support reasoning effort as a separate control.
    // Reasoning is managed via config options when available.
    logger.debug('setSessionReasoningEffort is a no-op for ACP sessions', { sessionId });
  }

  async setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void> {
    await this.sessionConfigService.setSessionThinkingBudget(sessionId, maxTokens);
  }

  /**
   * Set an ACP config option by ID. Calls the agent SDK and emits the
   * authoritative config_options_update delta to all subscribers.
   */
  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.sessionConfigService.setSessionConfigOption(sessionId, configId, value);
  }

  sendSessionMessage(sessionId: string, content: string | AgentContentItem[]): Promise<void> {
    const acpClient = this.runtimeManager.getClient(sessionId);
    if (acpClient) {
      const normalizedText =
        typeof content === 'string' ? content : this.normalizeContentToText(content);
      return this.sendAcpMessage(sessionId, normalizedText).then(
        () => {
          // Prompt completed successfully -- no action needed
        },
        (error) => {
          logger.error('ACP prompt failed', {
            sessionId,
            error: toErrorMessage(error),
          });
        }
      );
    }

    logger.warn('No ACP client found for sendSessionMessage', { sessionId });
    return Promise.resolve();
  }

  /**
   * Normalize AgentContentItem[] to a plain text string for ACP.
   */
  private normalizeContentToText(content: AgentContentItem[]): string {
    const chunks: string[] = [];
    for (const item of content) {
      switch (item.type) {
        case 'text':
          chunks.push(item.text);
          break;
        case 'thinking':
          chunks.push(item.thinking);
          break;
        case 'image':
          chunks.push('[Image attachment omitted for this provider]');
          break;
        case 'tool_result':
          if (typeof item.content === 'string') {
            chunks.push(item.content);
          } else {
            chunks.push(JSON.stringify(item.content));
          }
          break;
        default:
          break;
      }
    }

    return chunks.join('\n\n');
  }

  /**
   * Send a message via ACP runtime. Returns the stop reason from the prompt response.
   * The prompt() call blocks until the turn completes; streaming events arrive
   * concurrently via the AcpClientHandler.sessionUpdate callback.
   */
  async sendAcpMessage(sessionId: string, content: string): Promise<string> {
    const workspaceId = this.sessionToWorkspace.get(sessionId);
    // Scope orphan detection to each prompt turn.
    this.pendingAcpToolCalls.set(sessionId, new Map());

    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: new Date().toISOString(),
    });

    if (workspaceId && this.workspaceBridge) {
      this.workspaceBridge.markSessionRunning(workspaceId, sessionId);
    }

    try {
      const result = await this.runtimeManager.sendPrompt(sessionId, content);
      this.finalizeOrphanedToolCalls(sessionId, `stop_reason:${result.stopReason}`);
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return result.stopReason;
    } catch (error) {
      this.finalizeOrphanedToolCalls(sessionId, 'prompt_error');
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'error',
        processState: 'alive',
        activity: 'IDLE',
        errorMessage: toErrorMessage(error),
        updatedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      if (workspaceId && this.workspaceBridge) {
        this.workspaceBridge.markSessionIdle(workspaceId, sessionId);
      }
      this.schedulePromptTurnComplete(sessionId);
    }
  }

  private schedulePromptTurnComplete(sessionId: string): void {
    if (!this.promptTurnCompleteHandler) {
      return;
    }

    setTimeout(() => {
      void this.notifyPromptTurnComplete(sessionId);
    }, 0);
  }

  private async notifyPromptTurnComplete(sessionId: string): Promise<void> {
    if (!this.promptTurnCompleteHandler) {
      return;
    }

    try {
      await this.promptTurnCompleteHandler(sessionId);
    } catch (error) {
      logger.warn('Prompt turn completion handler failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Cancel an ongoing ACP prompt mid-turn.
   */
  async cancelAcpPrompt(sessionId: string): Promise<void> {
    await this.runtimeManager.cancelPrompt(sessionId);
  }

  getSessionConversationHistory(sessionId: string, _workingDir: string): HistoryMessage[] {
    const transcript = this.sessionDomainService.getTranscriptSnapshot(sessionId);
    return transcript.flatMap((entry) => this.mapTranscriptEntryToHistory(entry));
  }

  private mapTranscriptEntryToHistory(entry: ChatMessage): HistoryMessage[] {
    if (entry.source === 'user') {
      return entry.text
        ? [
            {
              type: 'user',
              content: entry.text,
              timestamp: entry.timestamp,
            },
          ]
        : [];
    }

    const message = entry.message;
    if (!message || (message.type !== 'assistant' && message.type !== 'user')) {
      return [];
    }

    const content = this.extractMessageText(message);
    if (!content) {
      return [];
    }

    return [
      {
        type: message.type,
        content,
        timestamp: entry.timestamp,
      },
    ];
  }

  private extractMessageText(message: AgentMessage): string {
    const content = message.message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .filter((item): item is Extract<AgentContentItem, { type: 'text' }> => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .trim();
  }

  respondToAcpPermission(
    sessionId: string,
    requestId: string,
    optionId: string,
    answers?: Record<string, string[]>
  ): boolean {
    return this.sessionPermissionService.respondToPermission(
      sessionId,
      requestId,
      optionId,
      answers
    );
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    const fallback = createInitialSessionRuntimeState();
    const persisted = this.sessionDomainService.getRuntimeSnapshot(sessionId);
    const base = persisted ?? fallback;

    // Check ACP runtime
    const acpClient = this.runtimeManager.getClient(sessionId);
    if (acpClient) {
      const isWorking = this.runtimeManager.isSessionWorking(sessionId);
      return {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: base.updatedAt,
      };
    }

    if (this.runtimeManager.isStopInProgress(sessionId)) {
      return {
        ...base,
        phase: 'stopping',
        updatedAt: base.updatedAt,
      };
    }

    // Defensive normalization for stale runtime snapshots: persisted loading
    // can linger after reconnect churn even when no process exists.
    if (this.isStaleLoadingRuntime(base)) {
      return {
        ...base,
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: base.updatedAt,
      };
    }

    return base;
  }

  private async getOrCreateAcpSessionClient(
    sessionId: string,
    options: {
      model?: string;
      permissionMode?: SessionPermissionMode;
    },
    session: AgentSessionRecord
  ): Promise<AcpProcessHandle> {
    // Check for existing ACP client first
    const existingAcp = this.runtimeManager.getClient(sessionId);
    if (existingAcp) {
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: existingAcp.isPromptInFlight ? 'running' : 'idle',
        processState: 'alive',
        activity: existingAcp.isPromptInFlight ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return existingAcp;
    }

    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    let handle: AcpProcessHandle;
    try {
      handle = await this.createAcpClient(sessionId, options, session);
    } catch (error) {
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
        errorMessage: `Failed to start agent: ${toErrorMessage(error)}`,
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }

    await this.repository.updateSession(sessionId, {
      status: SessionStatus.RUNNING,
    });

    this.sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: handle.isPromptInFlight ? 'running' : 'idle',
      processState: 'alive',
      activity: handle.isPromptInFlight ? 'WORKING' : 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    return handle;
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * Check if a session is running in memory
   */
  isSessionRunning(sessionId: string): boolean {
    return this.runtimeManager.isSessionRunning(sessionId);
  }

  /**
   * Check if a session is actively working (not just alive, but processing)
   */
  isSessionWorking(sessionId: string): boolean {
    return this.runtimeManager.isSessionWorking(sessionId);
  }

  /**
   * Check if any session in the given list is actively working
   */
  isAnySessionWorking(sessionIds: string[]): boolean {
    return this.runtimeManager.isAnySessionWorking(sessionIds);
  }

  /**
   * Get session options for creating a client.
   * Loads the workflow prompt from the database session.
   * This is the single source of truth for session configuration.
   */
  async getSessionOptions(sessionId: string): Promise<{
    workingDir: string;
    resumeProviderSessionId: string | undefined;
    systemPrompt: string | undefined;
    model: string;
  } | null> {
    const sessionContext = await this.loadSessionContext(sessionId);
    if (!sessionContext) {
      return null;
    }

    return {
      workingDir: sessionContext.workingDir,
      resumeProviderSessionId: sessionContext.resumeProviderSessionId,
      systemPrompt: sessionContext.systemPrompt,
      model: sessionContext.model,
    };
  }

  getChatBarCapabilities(sessionId: string): Promise<ChatBarCapabilities> {
    return this.sessionConfigService.getChatBarCapabilities(sessionId);
  }

  /**
   * Build ChatBarCapabilities entirely from ACP configOptions.
   * No hardcoded fallback — capabilities are derived from what the agent reports.
   */
  private buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    return this.sessionConfigService.buildAcpChatBarCapabilities(handle);
  }

  /**
   * Stop all active clients during shutdown.
   * @param _timeoutMs - Timeout (unused, kept for API compatibility)
   */
  async stopAllClients(_timeoutMs = 5000): Promise<void> {
    try {
      await this.runtimeManager.stopAllClients();
    } catch (error) {
      logger.error('Failed to stop ACP clients during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private async persistAcpConfigSnapshot(
    sessionId: string,
    params: PersistAcpConfigSnapshotParams
  ): Promise<void> {
    await this.sessionConfigService.persistAcpConfigSnapshot(sessionId, params);
  }

  private async loadSessionContext(
    sessionId: string,
    preloadedSession?: AgentSessionRecord
  ): Promise<{
    workingDir: string;
    resumeProviderSessionId: string | undefined;
    systemPrompt: string | undefined;
    model: string;
    workspaceId: string;
  } | null> {
    const session = preloadedSession ?? (await this.repository.getSessionById(sessionId));
    if (!session) {
      logger.warn('Session not found when getting options', { sessionId });
      return null;
    }

    const workspace = await this.repository.getWorkspaceById(session.workspaceId);
    if (!workspace?.worktreePath) {
      logger.warn('Workspace or worktree not found', {
        sessionId,
        workspaceId: session.workspaceId,
      });
      return null;
    }

    const shouldInjectBranchRename = this.promptBuilder.shouldInjectBranchRename({
      branchName: workspace.branchName,
      isAutoGeneratedBranch: workspace.isAutoGeneratedBranch,
      hasHadSessions: workspace.hasHadSessions,
    });
    const project = shouldInjectBranchRename
      ? await this.repository.getProjectById(workspace.projectId)
      : null;
    if (shouldInjectBranchRename && !project) {
      logger.warn('Project not found when building branch rename instruction', {
        sessionId,
        projectId: workspace.projectId,
      });
    }

    const { workflowPrompt, systemPrompt, injectedBranchRename } =
      this.promptBuilder.buildSystemPrompt({
        workflow: session.workflow,
        workspace: {
          branchName: workspace.branchName,
          isAutoGeneratedBranch: workspace.isAutoGeneratedBranch,
          hasHadSessions: workspace.hasHadSessions,
          name: workspace.name,
          description: workspace.description ?? undefined,
        },
        project,
      });

    logger.info('Loaded workflow prompt for session options', {
      sessionId,
      workflow: session.workflow,
      hasPrompt: !!workflowPrompt,
      promptLength: workflowPrompt?.length ?? 0,
    });
    if (injectedBranchRename) {
      logger.info('Injected branch rename instruction', {
        sessionId,
        branchName: workspace.branchName,
        branchPrefix: project?.githubOwner,
      });
    }

    return {
      workingDir: workspace.worktreePath,
      resumeProviderSessionId: session.providerSessionId ?? undefined,
      systemPrompt,
      model: session.model,
      workspaceId: workspace.id,
    };
  }
}

export function createSessionService(options?: SessionServiceDependencies): SessionService {
  return new SessionService(options);
}

export const sessionService = createSessionService();
