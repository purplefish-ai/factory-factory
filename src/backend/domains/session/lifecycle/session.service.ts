import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type {
  AcpClientOptions,
  AcpProcessHandle,
  AcpRuntimeManager,
} from '@/backend/domains/session/acp';
import { type AcpRuntimeEventHandlers, acpRuntimeManager } from '@/backend/domains/session/acp';
import type { SessionLifecycleWorkspaceBridge } from '@/backend/domains/session/bridges';
import { chatConnectionService } from '@/backend/domains/session/chat/chat-connection.service';
import { acpTraceLogger } from '@/backend/domains/session/logging/acp-trace-logger.service';
import {
  type SessionDomainService,
  sessionDomainService,
} from '@/backend/domains/session/session-domain.service';
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
import { AcpEventProcessor } from './acp-event-processor';
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
  private readonly sessionPermissionService: SessionPermissionService;
  private readonly sessionConfigService: SessionConfigService;
  private readonly acpEventProcessor: AcpEventProcessor;
  /** Cross-domain bridge for workspace activity (injected by orchestration layer) */
  private workspaceBridge: SessionLifecycleWorkspaceBridge | null = null;
  /** Optional callback invoked after an ACP prompt turn settles. */
  private promptTurnCompleteHandler: PromptTurnCompleteHandler | null = null;
  private readonly promptTurnCompleteTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Configure cross-domain bridges. Called once at startup by orchestration layer.
   */
  configure(bridges: { workspace: SessionLifecycleWorkspaceBridge }): void {
    this.workspaceBridge = bridges.workspace;
  }

  setPromptTurnCompleteHandler(handler: PromptTurnCompleteHandler | null): void {
    this.promptTurnCompleteHandler = handler;
    if (!handler) {
      this.clearAllScheduledPromptTurnCompletions();
    }
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
    const runtimeEventHandler = this.acpEventProcessor.createRuntimeEventHandler(sessionId);

    return {
      ...runtimeEventHandler,
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
        this.clearScheduledPromptTurnCompletion(sid);
        // Clean up permission bridge, streaming state, and workspace mapping on exit
        this.acpEventProcessor.clearSessionState(sid);
        this.sessionPermissionService.cancelPendingRequests(sid);
        acpTraceLogger.log(sid, 'runtime_exit', { exitCode });

        try {
          this.sessionDomainService.markProcessExit(sid, exitCode);
          const session = await this.repository.updateSession(sid, {
            status: SessionStatus.COMPLETED,
          });
          logger.debug('Updated ACP session status to COMPLETED on exit', { sessionId: sid });

          await this.clearRatchetActiveSessionIfMatching(session.workspaceId, sid);
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
          this.clearSessionStoreIfInactive(sid, 'runtime_exit');
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
        this.acpEventProcessor.handleAcpLog(sid, payload);
      },
    };
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
    this.acpEventProcessor.registerSessionContext(sessionId, {
      workspaceId: sessionContext.workspaceId,
      workingDir: sessionContext.workingDir,
    });

    const handlers = this.setupAcpEventHandler(sessionId);
    const shouldSuppressReplay = this.shouldSuppressReplayDuringAcpResume(sessionId, session);
    this.acpEventProcessor.setReplaySuppression(sessionId, shouldSuppressReplay);

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
      this.acpEventProcessor.clearSessionState(sessionId);
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
    this.acpEventProcessor = new AcpEventProcessor({
      runtimeManager: this.runtimeManager,
      sessionDomainService: this.sessionDomainService,
      sessionPermissionService: this.sessionPermissionService,
      sessionConfigService: this.sessionConfigService,
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
    this.clearScheduledPromptTurnCompletion(sessionId);
    const session = await this.loadSessionForStop(sessionId);
    const workspaceId = session?.workspaceId ?? this.acpEventProcessor.getWorkspaceId(sessionId);

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
    this.acpEventProcessor.clearStreamingState(sessionId);
    this.acpEventProcessor.clearReplaySuppression(sessionId);
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
      this.acpEventProcessor.clearSessionContext(sessionId);

      if (!stopClientFailed) {
        const shouldCleanupTransientRatchetSession =
          options?.cleanupTransientRatchetSession ?? true;
        await this.cleanupTransientRatchetOnStop(
          session,
          sessionId,
          shouldCleanupTransientRatchetSession
        );
      }

      this.clearSessionStoreIfInactive(sessionId, 'manual_stop');
      logger.info('ACP session stopped', {
        sessionId,
        ...(stopClientFailed ? { runtimeStopFailed: true } : {}),
      });
      acpTraceLogger.closeSession(sessionId);
    }
  }

  private finalizeOrphanedToolCallsOnStop(sessionId: string): void {
    try {
      this.acpEventProcessor.finalizeOrphanedToolCalls(sessionId, 'session_stop');
    } catch (error) {
      logger.warn('Failed finalizing orphaned ACP tool calls during stop', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.acpEventProcessor.clearPendingToolCalls(sessionId);
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
      await this.clearRatchetActiveSessionIfMatching(session.workspaceId, sessionId);
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

  private async clearRatchetActiveSessionIfMatching(
    workspaceId: string,
    sessionId: string
  ): Promise<void> {
    if (!this.workspaceBridge) {
      return;
    }

    await this.workspaceBridge.clearRatchetActiveSessionIfMatching(workspaceId, sessionId);
  }

  private hasSessionViewers(sessionId: string): boolean {
    for (const info of chatConnectionService.values()) {
      if (info.dbSessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  private clearSessionStoreIfInactive(
    sessionId: string,
    reason: 'manual_stop' | 'runtime_exit'
  ): void {
    if (this.runtimeManager.isSessionRunning(sessionId) || this.hasSessionViewers(sessionId)) {
      return;
    }
    this.sessionDomainService.clearSession(sessionId);
    logger.debug('Cleared inactive in-memory session state', { sessionId, reason });
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
    const workspaceId = this.acpEventProcessor.getWorkspaceId(sessionId);
    // Scope orphan detection to each prompt turn.
    this.acpEventProcessor.beginPromptTurn(sessionId);

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
      this.acpEventProcessor.finalizeOrphanedToolCalls(
        sessionId,
        `stop_reason:${result.stopReason}`
      );
      this.sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return result.stopReason;
    } catch (error) {
      this.acpEventProcessor.finalizeOrphanedToolCalls(sessionId, 'prompt_error');
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

    this.clearScheduledPromptTurnCompletion(sessionId);
    const timeout = setTimeout(() => {
      this.promptTurnCompleteTimeouts.delete(sessionId);
      void this.notifyPromptTurnComplete(sessionId);
    }, 0);
    this.promptTurnCompleteTimeouts.set(sessionId, timeout);
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

  private clearScheduledPromptTurnCompletion(sessionId: string): void {
    const timeout = this.promptTurnCompleteTimeouts.get(sessionId);
    if (!timeout) {
      return;
    }

    clearTimeout(timeout);
    this.promptTurnCompleteTimeouts.delete(sessionId);
  }

  private clearAllScheduledPromptTurnCompletions(): void {
    for (const timeout of this.promptTurnCompleteTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.promptTurnCompleteTimeouts.clear();
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
   * @param timeoutMs - Maximum wait time for each client shutdown attempt
   */
  async stopAllClients(timeoutMs = 5000): Promise<void> {
    this.clearAllScheduledPromptTurnCompletions();
    try {
      await this.runtimeManager.stopAllClients(timeoutMs);
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
