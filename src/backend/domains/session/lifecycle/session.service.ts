import type { SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import type { AcpClientOptions, AcpProcessHandle } from '@/backend/domains/session/acp';
import {
  AcpEventTranslator,
  AcpPermissionBridge,
  type AcpRuntimeEventHandlers,
  acpRuntimeManager,
} from '@/backend/domains/session/acp';
import type { SessionWorkspaceBridge } from '@/backend/domains/session/bridges';
import { acpTraceLogger } from '@/backend/domains/session/logging/acp-trace-logger.service';
import { sessionFileLogger } from '@/backend/domains/session/logging/session-file-logger.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import type { AgentSessionRecord } from '@/backend/resource_accessors/agent-session.accessor';
import { createLogger } from '@/backend/services/logger.service';
import type {
  AgentContentItem,
  AgentMessage,
  AskUserQuestion,
  ChatMessage,
  HistoryMessage,
  SessionDeltaEvent,
} from '@/shared/acp-protocol';
import { extractPlanText } from '@/shared/acp-protocol/plan-content';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { SessionStatus } from '@/shared/core';
import { isUserQuestionRequest } from '@/shared/pending-request-types';
import {
  createInitialSessionRuntimeState,
  type SessionRuntimeState,
} from '@/shared/session-runtime';
import type { SessionPromptBuilder } from './session.prompt-builder';
import { sessionPromptBuilder } from './session.prompt-builder';
import type { SessionRepository } from './session.repository';
import { sessionRepository } from './session.repository';

const logger = createLogger('session');
const STALE_LOADING_RUNTIME_MAX_AGE_MS = 30_000;
type SessionProvider = 'CLAUDE' | 'CODEX';
type StoredAcpConfigSnapshot = {
  provider: SessionProvider;
  providerSessionId: string;
  capturedAt: string;
  configOptions: SessionConfigOption[];
  observedModelId?: string;
};
type PendingAcpToolCall = {
  toolUseId: string;
  toolName: string;
  acpKind?: string;
  acpLocations?: Array<{ path: string; line?: number | null }>;
};

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

class SessionService {
  private readonly repository: SessionRepository;
  private readonly promptBuilder: SessionPromptBuilder;
  private readonly acpEventTranslator = new AcpEventTranslator(logger);
  private readonly acpPermissionBridges = new Map<string, AcpPermissionBridge>();
  /** Per-session text accumulation state for ACP streaming (reuses order so frontend upserts). */
  private readonly acpStreamState = new Map<string, { textOrder: number; accText: string }>();
  /** Per-session ACP tool calls that have started but not reached terminal status. */
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

  /**
   * Configure cross-domain bridges. Called once at startup by orchestration layer.
   */
  configure(bridges: {
    workspace: Pick<SessionWorkspaceBridge, 'markSessionRunning' | 'markSessionIdle'>;
  }): void {
    this.workspaceBridge = bridges.workspace as SessionWorkspaceBridge;
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
    const bridge = new AcpPermissionBridge();
    this.acpPermissionBridges.set(sessionId, bridge);

    return {
      permissionBridge: bridge,
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
          this.handleAcpPermissionRequest(sid, event);
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
        const b = this.acpPermissionBridges.get(sid);
        if (b) {
          b.cancelAll();
          this.acpPermissionBridges.delete(sid);
        }
        acpTraceLogger.log(sid, 'runtime_exit', { exitCode });

        try {
          sessionDomainService.markProcessExit(sid, exitCode);
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
      const acpHandle = acpRuntimeManager.getClient(sid);
      if (acpHandle) {
        const { configOptions } = delta as { configOptions: unknown[] };
        acpHandle.configOptions = configOptions as SessionConfigOption[];
        void this.persistAcpConfigSnapshot(sid, {
          provider: acpHandle.provider as SessionProvider,
          providerSessionId: acpHandle.providerSessionId,
          configOptions: acpHandle.configOptions,
        });
        sessionDomainService.emitDelta(sid, delta);
        sessionDomainService.emitDelta(sid, {
          type: 'chat_capabilities',
          capabilities: this.buildAcpChatBarCapabilities(acpHandle),
        });
        return;
      }
    }

    if (delta.type !== 'agent_message') {
      sessionDomainService.emitDelta(sid, delta);
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
    const order = sessionDomainService.appendClaudeEvent(sid, data);
    sessionDomainService.emitDelta(sid, { ...delta, order });
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
          content_block?: { type?: string; id?: unknown; name?: unknown };
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
    this.upsertPendingToolCall(sid, toolUseId, { toolName });
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
    if (progress.acpStatus && TERMINAL_TOOL_STATUSES.has(progress.acpStatus)) {
      this.removePendingToolCall(sid, progress.tool_use_id);
      return;
    }
    this.upsertPendingToolCall(sid, progress.tool_use_id, {
      toolName: progress.tool_name ?? 'ACP Tool',
      acpKind: progress.acpKind,
      acpLocations: progress.acpLocations,
    });
  }

  private upsertPendingToolCall(
    sid: string,
    toolUseId: string,
    update: Pick<PendingAcpToolCall, 'toolName'> &
      Partial<Pick<PendingAcpToolCall, 'acpKind' | 'acpLocations'>>
  ): void {
    const pendingById = this.pendingAcpToolCalls.get(sid) ?? new Map<string, PendingAcpToolCall>();
    const existing = pendingById.get(toolUseId);
    pendingById.set(toolUseId, {
      toolUseId,
      toolName: update.toolName || existing?.toolName || 'ACP Tool',
      acpKind: update.acpKind ?? existing?.acpKind,
      acpLocations: update.acpLocations ?? existing?.acpLocations,
    });
    this.pendingAcpToolCalls.set(sid, pendingById);
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
    if (acpRuntimeManager.isSessionWorking(sid)) {
      return;
    }
    const normalized = text.trim();
    if (normalized.length === 0) {
      return;
    }
    sessionDomainService.injectCommittedUserMessage(sid, normalized);
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
      ss = { textOrder: sessionDomainService.allocateOrder(sid), accText: '' };
      this.acpStreamState.set(sid, ss);
    }
    ss.accText += chunkText;
    const accMsg: AgentMessage = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: ss.accText }] },
    };
    sessionDomainService.upsertClaudeEvent(sid, accMsg, ss.textOrder);
    sessionDomainService.emitDelta(sid, {
      type: 'agent_message',
      data: accMsg,
      order: ss.textOrder,
    } as SessionDeltaEvent & { order: number });
  }

  private handleAcpPermissionRequest(sid: string, event: unknown): void {
    const { requestId, params } = event as {
      type: string;
      requestId: string;
      params: import('@agentclientprotocol/sdk').RequestPermissionRequest;
    };
    const toolName = params.toolCall.title ?? 'ACP Tool';
    const toolInput = (params.toolCall.rawInput as Record<string, unknown>) ?? {};
    const acpOptions = params.options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    }));
    const planContent = this.extractPlanContent(toolName, toolInput);

    if (isUserQuestionRequest({ toolName, input: toolInput })) {
      const questions = this.extractAskUserQuestions(toolInput);
      sessionDomainService.emitDelta(sid, {
        type: 'user_question',
        requestId,
        questions,
        acpOptions,
      });
    } else {
      sessionDomainService.emitDelta(sid, {
        type: 'permission_request',
        requestId,
        toolName,
        toolUseId: params.toolCall.toolCallId,
        toolInput,
        planContent,
        acpOptions,
      });
    }

    sessionDomainService.setPendingInteractiveRequest(sid, {
      requestId,
      toolName,
      toolUseId: params.toolCall.toolCallId,
      input: toolInput,
      planContent,
      acpOptions,
      timestamp: new Date().toISOString(),
    });
  }

  private extractAskUserQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    const questions = input.questions;
    if (!Array.isArray(questions)) {
      return [];
    }
    return questions as AskUserQuestion[];
  }

  private extractPlanContent(toolName: string, input: Record<string, unknown>): string | null {
    if (toolName !== 'ExitPlanMode') {
      return null;
    }

    return extractPlanText(input.plan);
  }

  private async createAcpClient(
    sessionId: string,
    options?: {
      model?: string;
      permissionMode?: 'bypassPermissions' | 'plan';
    },
    session?: AgentSessionRecord
  ): Promise<AcpProcessHandle> {
    const sessionContext = await this.loadSessionContext(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session context not ready: ${sessionId}`);
    }

    await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
    this.sessionToWorkspace.set(sessionId, sessionContext.workspaceId);

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
      handle = await acpRuntimeManager.getOrCreateClient(sessionId, clientOptions, handlers, {
        workspaceId: sessionContext.workspaceId,
        workingDir: sessionContext.workingDir,
      });
    } catch (error) {
      this.suppressAcpReplayForSession.delete(sessionId);
      throw error;
    }

    await this.persistAcpConfigSnapshot(sessionId, {
      provider: handle.provider as SessionProvider,
      providerSessionId: handle.providerSessionId,
      configOptions: handle.configOptions,
      existingMetadata: session?.providerMetadata ?? undefined,
    });

    // Emit initial config options so the frontend receives them on session start
    if (handle.configOptions.length > 0) {
      sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions: handle.configOptions,
      } as SessionDeltaEvent);
    }

    // Re-emit chat_capabilities now that the ACP handle exists.
    // The initial load_session fires before the handle is ready, so the
    // frontend would otherwise be stuck with EMPTY capabilities.
    sessionDomainService.emitDelta(sessionId, {
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

    if (!sessionDomainService.isHistoryHydrated(sessionId)) {
      return false;
    }

    return sessionDomainService.getTranscriptSnapshot(sessionId).length > 0;
  }

  private maybeLiftReplaySuppression(sessionId: string): void {
    if (!this.suppressAcpReplayForSession.has(sessionId)) {
      return;
    }
    if (!acpRuntimeManager.isSessionWorking(sessionId)) {
      return;
    }
    this.suppressAcpReplayForSession.delete(sessionId);
  }

  constructor(options?: {
    repository?: SessionRepository;
    promptBuilder?: SessionPromptBuilder;
  }) {
    this.repository = options?.repository ?? sessionRepository;
    this.promptBuilder = options?.promptBuilder ?? sessionPromptBuilder;
  }

  /**
   * Start a session using the ACP runtime.
   */
  async startSession(sessionId: string, options?: { initialPrompt?: string }): Promise<void> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (acpRuntimeManager.isStopInProgress(sessionId)) {
      throw new Error('Session is currently being stopped');
    }

    // Check if session is already running to prevent duplicate message sends
    const existingClient = acpRuntimeManager.getClient(sessionId);
    if (existingClient) {
      throw new Error('Session is already running');
    }

    // Use getOrCreate for race-protected creation
    await this.getOrCreateAcpSessionClient(
      sessionId,
      { permissionMode: 'bypassPermissions' },
      session
    );

    // Send initial prompt - defaults to 'Continue with the task.' if not provided
    const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
    if (initialPrompt) {
      await this.sendSessionMessage(sessionId, initialPrompt);
    }

    logger.info('Session started', { sessionId, provider: session.provider });
  }

  /**
   * Stop a session gracefully via the ACP runtime.
   */
  async stopSession(
    sessionId: string,
    options?: { cleanupTransientRatchetSession?: boolean }
  ): Promise<void> {
    const session = await this.loadSessionForStop(sessionId);

    if (acpRuntimeManager.isStopInProgress(sessionId)) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
    }

    const current = this.getRuntimeSnapshot(sessionId);
    sessionDomainService.setRuntimeSnapshot(sessionId, {
      ...current,
      phase: 'stopping',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    // Cancel pending ACP permissions and clean up streaming state
    this.acpStreamState.delete(sessionId);
    this.pendingAcpToolCalls.delete(sessionId);
    this.suppressAcpReplayForSession.delete(sessionId);
    const acpBridge = this.acpPermissionBridges.get(sessionId);
    if (acpBridge) {
      acpBridge.cancelAll();
      this.acpPermissionBridges.delete(sessionId);
    }

    let stopClientFailed = false;
    try {
      if (!acpRuntimeManager.isStopInProgress(sessionId)) {
        await acpRuntimeManager.stopClient(sessionId);
      }
    } catch (error) {
      stopClientFailed = true;
      logger.warn('Error stopping ACP session runtime; continuing cleanup', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await this.updateStoppedSessionState(sessionId);
      sessionDomainService.clearQueuedWork(sessionId, { emitSnapshot: false });
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });

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
        acpRuntimeManager.isSessionRunning(session.id)
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
      permissionMode?: 'bypassPermissions' | 'plan';
      model?: string;
      reasoningEffort?: string;
    }
  ): Promise<unknown> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return await this.getOrCreateAcpSessionClient(sessionId, options ?? {}, session);
  }

  /**
   * Reuses a preloaded session record to avoid redundant lookups and reduce
   * races between separate reads during load_session initialization.
   */
  async getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: 'bypassPermissions' | 'plan';
      model?: string;
      reasoningEffort?: string;
    }
  ): Promise<unknown> {
    return await this.getOrCreateAcpSessionClient(session.id, options ?? {}, session);
  }

  getSessionClient(sessionId: string): unknown | undefined {
    return acpRuntimeManager.getClient(sessionId);
  }

  getSessionConfigOptions(sessionId: string): SessionConfigOption[] {
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    return acpHandle ? [...acpHandle.configOptions] : [];
  }

  async getSessionConfigOptionsWithFallback(sessionId: string): Promise<SessionConfigOption[]> {
    const liveConfigOptions = this.getSessionConfigOptions(sessionId);
    if (liveConfigOptions.length > 0) {
      return liveConfigOptions;
    }

    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      return [];
    }

    const cachedSnapshot = this.extractAcpConfigSnapshot(session.providerMetadata);
    if (cachedSnapshot && cachedSnapshot.provider === session.provider) {
      return [...cachedSnapshot.configOptions];
    }

    return [];
  }

  async setSessionModel(sessionId: string, model?: string): Promise<void> {
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (acpHandle) {
      const modelOption = acpHandle.configOptions.find((o) => o.category === 'model');
      if (modelOption && model) {
        const availableValues = this.getConfigOptionValues(modelOption);
        if (availableValues.length > 0 && !availableValues.includes(model)) {
          logger.debug('Skipping unsupported model for ACP session', {
            sessionId,
            provider: acpHandle.provider,
            model,
            availableValues,
          });
          return;
        }
        await this.setSessionConfigOption(sessionId, modelOption.id, model);
      }
      return;
    }
    // No ACP handle found -- session may not be running
    logger.debug('No ACP handle for setSessionModel', { sessionId, model });
  }

  setSessionReasoningEffort(sessionId: string, _effort: string | null): void {
    // ACP sessions do not support reasoning effort as a separate control.
    // Reasoning is managed via config options when available.
    logger.debug('setSessionReasoningEffort is a no-op for ACP sessions', { sessionId });
  }

  async setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void> {
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (acpHandle) {
      const thoughtOption = acpHandle.configOptions.find((o) => o.category === 'thought_level');
      if (thoughtOption && maxTokens != null) {
        await this.setSessionConfigOption(sessionId, thoughtOption.id, String(maxTokens));
      }
      return;
    }
    logger.debug('No ACP handle for setSessionThinkingBudget', { sessionId, maxTokens });
  }

  /**
   * Set an ACP config option by ID. Calls the agent SDK and emits the
   * authoritative config_options_update delta to all subscribers.
   */
  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    const selectedOption = acpHandle?.configOptions.find((option) => option.id === configId);
    const isModeOption = configId === 'mode' || selectedOption?.category === 'mode';
    const isModelOption = configId === 'model' || selectedOption?.category === 'model';

    const configOptions = isModeOption
      ? await acpRuntimeManager.setSessionMode(sessionId, value)
      : isModelOption
        ? await acpRuntimeManager.setSessionModel(sessionId, value)
        : await acpRuntimeManager.setConfigOption(sessionId, configId, value);
    sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);
    const acpHandleAfterUpdate = acpRuntimeManager.getClient(sessionId);
    if (acpHandleAfterUpdate) {
      await this.persistAcpConfigSnapshot(sessionId, {
        provider: acpHandleAfterUpdate.provider as SessionProvider,
        providerSessionId: acpHandleAfterUpdate.providerSessionId,
        configOptions: configOptions,
      });
    }
  }

  sendSessionMessage(sessionId: string, content: string | AgentContentItem[]): Promise<void> {
    const acpClient = acpRuntimeManager.getClient(sessionId);
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
            error:
              error instanceof Error
                ? error.message
                : typeof error === 'object'
                  ? JSON.stringify(error)
                  : String(error),
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

    sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: new Date().toISOString(),
    });

    if (workspaceId && this.workspaceBridge) {
      this.workspaceBridge.markSessionRunning(workspaceId, sessionId);
    }

    try {
      const result = await acpRuntimeManager.sendPrompt(sessionId, content);
      this.finalizeOrphanedToolCalls(sessionId, `stop_reason:${result.stopReason}`);
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return result.stopReason;
    } catch (error) {
      this.finalizeOrphanedToolCalls(sessionId, 'prompt_error');
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'error',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      if (workspaceId && this.workspaceBridge) {
        this.workspaceBridge.markSessionIdle(workspaceId, sessionId);
      }
    }
  }

  /**
   * Cancel an ongoing ACP prompt mid-turn.
   */
  async cancelAcpPrompt(sessionId: string): Promise<void> {
    await acpRuntimeManager.cancelPrompt(sessionId);
  }

  getSessionConversationHistory(sessionId: string, _workingDir: string): HistoryMessage[] {
    const transcript = sessionDomainService.getTranscriptSnapshot(sessionId);
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

  respondToAcpPermission(sessionId: string, requestId: string, optionId: string): boolean {
    const bridge = this.acpPermissionBridges.get(sessionId);
    if (!bridge) {
      return false;
    }
    return bridge.resolvePermission(requestId, optionId);
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    const fallback = createInitialSessionRuntimeState();
    const persisted = sessionDomainService.getRuntimeSnapshot(sessionId);
    const base = persisted ?? fallback;

    // Check ACP runtime
    const acpClient = acpRuntimeManager.getClient(sessionId);
    if (acpClient) {
      const isWorking = acpRuntimeManager.isSessionWorking(sessionId);
      return {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: base.updatedAt,
      };
    }

    if (acpRuntimeManager.isStopInProgress(sessionId)) {
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
      permissionMode?: 'bypassPermissions' | 'plan';
    },
    session: AgentSessionRecord
  ): Promise<AcpProcessHandle> {
    // Check for existing ACP client first
    const existingAcp = acpRuntimeManager.getClient(sessionId);
    if (existingAcp) {
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: existingAcp.isPromptInFlight ? 'running' : 'idle',
        processState: 'alive',
        activity: existingAcp.isPromptInFlight ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return existingAcp;
    }

    sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    const handle = await this.createAcpClient(sessionId, options, session);

    await this.repository.updateSession(sessionId, {
      status: SessionStatus.RUNNING,
    });

    sessionDomainService.setRuntimeSnapshot(sessionId, {
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
    return acpRuntimeManager.isSessionRunning(sessionId);
  }

  /**
   * Check if a session is actively working (not just alive, but processing)
   */
  isSessionWorking(sessionId: string): boolean {
    return acpRuntimeManager.isSessionWorking(sessionId);
  }

  /**
   * Check if any session in the given list is actively working
   */
  isAnySessionWorking(sessionIds: string[]): boolean {
    return acpRuntimeManager.isAnySessionWorking(sessionIds);
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

  async getChatBarCapabilities(sessionId: string): Promise<ChatBarCapabilities> {
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (acpHandle) {
      return this.buildAcpChatBarCapabilities(acpHandle);
    }

    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      return EMPTY_CHAT_BAR_CAPABILITIES;
    }

    const cachedSnapshot = this.extractAcpConfigSnapshot(session.providerMetadata);
    if (cachedSnapshot && cachedSnapshot.provider === session.provider) {
      return this.buildCapabilitiesFromConfigOptions(
        session.provider,
        cachedSnapshot.configOptions,
        cachedSnapshot.observedModelId
      );
    }

    if (session.provider === 'CODEX') {
      return {
        ...EMPTY_CHAT_BAR_CAPABILITIES,
        provider: 'CODEX',
      };
    }

    return EMPTY_CHAT_BAR_CAPABILITIES;
  }

  /**
   * Build ChatBarCapabilities entirely from ACP configOptions.
   * No hardcoded fallback — capabilities are derived from what the agent reports.
   */
  private buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    return this.buildCapabilitiesFromConfigOptions(
      handle.provider as SessionProvider,
      handle.configOptions
    );
  }

  private buildCapabilitiesFromConfigOptions(
    provider: SessionProvider,
    configOptions: SessionConfigOption[],
    fallbackModel?: string
  ): ChatBarCapabilities {
    const modelOption = configOptions.find((o) => o.category === 'model');
    const modeOption = configOptions.find((o) => o.category === 'mode');
    const thoughtOption = configOptions.find(
      (o) =>
        o.category === 'thought_level' || o.id === 'reasoning_effort' || o.category === 'reasoning'
    );
    const selectedModel = modelOption?.currentValue
      ? String(modelOption.currentValue)
      : (fallbackModel ?? undefined);
    const modelOptions = this.buildModelOptions(modelOption, selectedModel);
    const isCodexProvider = provider === 'CODEX';
    const reasoningOptions =
      isCodexProvider && thoughtOption
        ? this.getSelectOptions(thoughtOption).map((option) => ({
            value: option.value,
            label: option.name ?? option.value,
            ...(option.description ? { description: option.description } : {}),
          }))
        : [];
    const reasoningValues = new Set(reasoningOptions.map((option) => option.value));
    const selectedReasoning =
      isCodexProvider &&
      thoughtOption?.currentValue &&
      typeof thoughtOption.currentValue === 'string' &&
      reasoningValues.has(thoughtOption.currentValue)
        ? thoughtOption.currentValue
        : undefined;
    const modeDescriptors = modeOption
      ? [
          ...this.getConfigOptionValues(modeOption),
          ...this.getSelectOptions(modeOption)
            .map((entry) => entry.name ?? '')
            .filter((value) => value.trim().length > 0),
        ]
      : [];
    const planModeEnabled = modeDescriptors.some((entry) => /plan/i.test(entry));

    return {
      provider,
      model: {
        enabled: modelOptions.length > 0,
        options: modelOptions,
        ...(selectedModel ? { selected: selectedModel } : {}),
      },
      reasoning: {
        enabled: reasoningOptions.length > 0,
        options: reasoningOptions,
        ...(selectedReasoning ? { selected: selectedReasoning } : {}),
      },
      thinking: {
        enabled: !isCodexProvider && !!thoughtOption,
      },
      planMode: { enabled: planModeEnabled },
      attachments: isCodexProvider
        ? { enabled: false, kinds: [] }
        : { enabled: true, kinds: ['image', 'text'] },
      slashCommands: { enabled: false },
      usageStats: { enabled: false, contextWindow: false },
      rewind: { enabled: false },
    };
  }

  private buildModelOptions(
    modelOption: SessionConfigOption | undefined,
    selectedModel: string | undefined
  ): Array<{ value: string; label: string }> {
    if (!modelOption) {
      return selectedModel ? [{ value: selectedModel, label: selectedModel }] : [];
    }

    const byValue = new Map<string, string>();
    for (const option of this.getSelectOptions(modelOption)) {
      if (!byValue.has(option.value)) {
        byValue.set(option.value, option.name ?? option.value);
      }
    }
    if (selectedModel && !byValue.has(selectedModel)) {
      byValue.set(selectedModel, selectedModel);
    }

    return Array.from(byValue.entries()).map(([value, label]) => ({ value, label }));
  }

  private getSelectOptions(option: SessionConfigOption): SessionConfigSelectOption[] {
    return option.options.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return [];
      }
      if ('value' in entry && typeof entry.value === 'string') {
        return [entry];
      }
      if ('options' in entry && Array.isArray(entry.options)) {
        return entry.options.filter(
          (grouped): grouped is SessionConfigSelectOption =>
            typeof grouped === 'object' && grouped !== null && typeof grouped.value === 'string'
        );
      }
      return [];
    });
  }

  private getConfigOptionValues(option: SessionConfigOption): string[] {
    return this.getSelectOptions(option).map((entry) => entry.value);
  }

  /**
   * Stop all active clients during shutdown.
   * @param _timeoutMs - Timeout (unused, kept for API compatibility)
   */
  async stopAllClients(_timeoutMs = 5000): Promise<void> {
    try {
      await acpRuntimeManager.stopAllClients();
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
    params: {
      provider: SessionProvider;
      providerSessionId: string;
      configOptions: SessionConfigOption[];
      existingMetadata?: unknown;
    }
  ): Promise<void> {
    if (params.configOptions.length === 0) {
      return;
    }

    const configOptionsForStorage = this.cloneConfigOptionsForStorage(params.configOptions);
    const observedModelId = this.resolveObservedModel(configOptionsForStorage);
    const metadataSource =
      params.existingMetadata ??
      (await this.repository.getSessionById(sessionId))?.providerMetadata ??
      null;

    const snapshot: StoredAcpConfigSnapshot = {
      provider: params.provider,
      providerSessionId: params.providerSessionId,
      capturedAt: new Date().toISOString(),
      configOptions: configOptionsForStorage,
      ...(observedModelId ? { observedModelId } : {}),
    };

    const persistedUpdate = this.buildSnapshotPersistUpdate(
      metadataSource,
      snapshot,
      observedModelId
    );

    try {
      await this.repository.updateSession(sessionId, persistedUpdate);
    } catch (error) {
      logger.warn('Failed persisting ACP config snapshot to session metadata; retrying once', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.retryPersistAcpConfigSnapshot(sessionId, snapshot, observedModelId);
    }
  }

  private buildSnapshotPersistUpdate(
    metadataSource: unknown,
    snapshot: StoredAcpConfigSnapshot,
    observedModelId: string | undefined
  ): {
    providerMetadata: AgentSessionRecord['providerMetadata'];
    model?: string;
  } {
    const nextMetadata: Record<string, unknown> = {
      ...this.toMetadataRecord(metadataSource),
      acpConfigSnapshot: snapshot,
    };
    if (observedModelId) {
      nextMetadata.observedModelId = observedModelId;
    }

    return {
      providerMetadata: nextMetadata as AgentSessionRecord['providerMetadata'],
      ...(observedModelId ? { model: observedModelId } : {}),
    };
  }

  private async retryPersistAcpConfigSnapshot(
    sessionId: string,
    snapshot: StoredAcpConfigSnapshot,
    observedModelId: string | undefined
  ): Promise<void> {
    try {
      const latestMetadataSource = (await this.repository.getSessionById(sessionId))
        ?.providerMetadata;
      await this.repository.updateSession(
        sessionId,
        this.buildSnapshotPersistUpdate(latestMetadataSource, snapshot, observedModelId)
      );
    } catch (retryError) {
      logger.warn('Retry failed persisting ACP config snapshot to session metadata', {
        sessionId,
        error: retryError instanceof Error ? retryError.message : String(retryError),
      });
    }
  }

  private cloneConfigOptionsForStorage(
    configOptions: SessionConfigOption[]
  ): SessionConfigOption[] {
    try {
      return structuredClone(configOptions);
    } catch {
      return configOptions;
    }
  }

  private toMetadataRecord(metadata: unknown): Record<string, unknown> {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return {};
    }
    return { ...(metadata as Record<string, unknown>) };
  }

  private extractAcpConfigSnapshot(metadata: unknown): StoredAcpConfigSnapshot | null {
    const record = this.toMetadataRecord(metadata);
    const snapshot = record.acpConfigSnapshot;
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      return null;
    }

    const candidate = snapshot as Record<string, unknown>;
    const provider = candidate.provider;
    const providerSessionId = candidate.providerSessionId;
    const configOptions = candidate.configOptions;
    const observedModelId = candidate.observedModelId;

    if (provider !== 'CLAUDE' && provider !== 'CODEX') {
      return null;
    }
    if (typeof providerSessionId !== 'string' || providerSessionId.length === 0) {
      return null;
    }
    if (!Array.isArray(configOptions)) {
      return null;
    }

    return {
      provider,
      providerSessionId,
      capturedAt:
        typeof candidate.capturedAt === 'string' ? candidate.capturedAt : new Date(0).toISOString(),
      configOptions: configOptions as SessionConfigOption[],
      ...(typeof observedModelId === 'string' ? { observedModelId } : {}),
    };
  }

  private resolveObservedModel(configOptions: SessionConfigOption[]): string | undefined {
    const modelOption = configOptions.find((option) => option.category === 'model');
    const currentValue = modelOption?.currentValue;
    return currentValue ? String(currentValue) : undefined;
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

export const sessionService = new SessionService();
