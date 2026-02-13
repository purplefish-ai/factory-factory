import { SessionStatus } from '@factory-factory/core';
import type { RewindFilesResponse } from '@/backend/domains/session/claude';
import type { ClaudeClient, ClaudeClientOptions } from '@/backend/domains/session/claude/client';
import type { ResourceUsage } from '@/backend/domains/session/claude/process';
import type { RegisteredProcess } from '@/backend/domains/session/claude/registry';
import { SessionManager } from '@/backend/domains/session/claude/session';
import { CodexEventTranslator } from '@/backend/domains/session/codex/codex-event-translator';
import { parseCodexThreadReadTranscript } from '@/backend/domains/session/codex/codex-thread-read-transcript';
import { parseTurnId } from '@/backend/domains/session/codex/payload-utils';
import {
  claudeSessionProviderAdapter,
  codexSessionProviderAdapter,
  type SessionProvider,
} from '@/backend/domains/session/providers';
import type { ClaudeRuntimeEventHandlers } from '@/backend/domains/session/runtime';
import type { CodexAppServerManager } from '@/backend/domains/session/runtime/codex-app-server-manager';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import {
  normalizeSessionModelForProvider,
  resolveSessionModelForProvider,
} from '@/backend/lib/session-model';
import type { AgentSessionRecord } from '@/backend/resource_accessors/agent-session.accessor';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import type {
  ChatMessage,
  ClaudeContentItem,
  ClaudeMessage,
  HistoryMessage,
  SessionDeltaEvent,
} from '@/shared/claude';
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

/**
 * Callback type for client creation hook.
 * Called after a ClaudeClient is created, allowing other services to set up
 * event forwarding without creating circular dependencies.
 */
export type ClientCreatedCallback = (
  sessionId: string,
  client: ClaudeClient,
  context: { workspaceId: string; workingDir: string }
) => void;

export type CodexTerminalTurnCallback = (sessionId: string) => void | Promise<void>;
type SessionAdapter = typeof claudeSessionProviderAdapter | typeof codexSessionProviderAdapter;
type LoadedSessionAdapter = {
  session: AgentSessionRecord;
  adapter: SessionAdapter;
};

class SessionService {
  private readonly repository: SessionRepository;
  private readonly promptBuilder: SessionPromptBuilder;
  private readonly claudeAdapter = claudeSessionProviderAdapter;
  private readonly codexAdapter = codexSessionProviderAdapter;
  private readonly sessionProviderCache = new Map<string, SessionProvider>();
  private readonly codexEventTranslator = new CodexEventTranslator({
    userInputEnabled: configService.getCodexAppServerConfig().requestUserInputEnabled,
  });
  private onCodexTerminalTurn: CodexTerminalTurnCallback | null = null;

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

  private cacheSessionProvider(sessionId: string, provider: SessionProvider): void {
    this.sessionProviderCache.set(sessionId, provider);
  }

  private clearSessionProvider(sessionId: string): void {
    this.sessionProviderCache.delete(sessionId);
  }

  private resolveAdapterForProvider(provider: SessionProvider) {
    return provider === 'CODEX' ? this.codexAdapter : this.claudeAdapter;
  }

  private resolveKnownAdapterForSessionSync(sessionId: string): SessionAdapter | null {
    if (
      this.codexAdapter.getClient(sessionId) ||
      this.codexAdapter.getPendingClient(sessionId) !== undefined ||
      this.codexAdapter.isStopInProgress(sessionId)
    ) {
      return this.codexAdapter;
    }

    if (
      this.claudeAdapter.getClient(sessionId) ||
      this.claudeAdapter.getPendingClient(sessionId) !== undefined ||
      this.claudeAdapter.isStopInProgress(sessionId)
    ) {
      return this.claudeAdapter;
    }

    const cached = this.sessionProviderCache.get(sessionId);
    if (cached) {
      return this.resolveAdapterForProvider(cached);
    }

    return null;
  }

  private resolveAdapterForSessionSync(sessionId: string) {
    return this.resolveKnownAdapterForSessionSync(sessionId) ?? this.claudeAdapter;
  }

  private notifyCodexTerminalTurn(sessionId: string): void {
    if (!this.onCodexTerminalTurn) {
      return;
    }

    Promise.resolve(this.onCodexTerminalTurn(sessionId)).catch((error) => {
      logger.warn('Codex terminal turn callback failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async loadSessionWithAdapter(sessionId: string): Promise<LoadedSessionAdapter> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.cacheSessionProvider(sessionId, session.provider);
    return {
      session,
      adapter: this.resolveAdapterForProvider(session.provider),
    };
  }

  /**
   * Register a callback to be called when a client is created.
   * Used by chat handler to set up event forwarding without circular dependencies.
   */
  setOnClientCreated(callback: ClientCreatedCallback): void {
    this.claudeAdapter.setOnClientCreated(callback);
  }

  setOnCodexTerminalTurn(callback: CodexTerminalTurnCallback): void {
    this.onCodexTerminalTurn = callback;
  }

  constructor(options?: {
    repository?: SessionRepository;
    promptBuilder?: SessionPromptBuilder;
  }) {
    this.repository = options?.repository ?? sessionRepository;
    this.promptBuilder = options?.promptBuilder ?? sessionPromptBuilder;
    this.initializeCodexManagerHandlers();
  }

  private initializeCodexManagerHandlers(): void {
    this.codexAdapter.getManager().setHandlers({
      onNotification: ({ sessionId, method, params }) => {
        const registry = this.codexAdapter.getManager().getRegistry();
        const isTerminalTurn = this.isTerminalCodexTurnMethod(method);
        if (isTerminalTurn) {
          registry.markTurnTerminal(sessionId, parseTurnId(params));
        }

        const translatedEvents = this.codexEventTranslator.translateNotification(method, params);
        for (const event of translatedEvents) {
          const normalized = this.normalizeCodexDeltaEvent(sessionId, event);
          if (normalized.type === 'session_runtime_updated') {
            sessionDomainService.setRuntimeSnapshot(sessionId, normalized.sessionRuntime, false);
          }
          sessionDomainService.emitDelta(sessionId, normalized);
        }

        if (isTerminalTurn) {
          this.notifyCodexTerminalTurn(sessionId);
        }
      },
      onServerRequest: ({ sessionId, method, params, canonicalRequestId }) => {
        const event = this.codexEventTranslator.translateServerRequest(
          method,
          canonicalRequestId,
          params
        );

        if (event.type === 'error') {
          try {
            this.codexAdapter.rejectInteractiveRequest(sessionId, canonicalRequestId, {
              message: event.message,
              data: event.data,
            });
          } catch (error) {
            logger.warn('Failed responding to unsupported Codex interactive request', {
              sessionId,
              requestId: canonicalRequestId,
              method,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        sessionDomainService.emitDelta(sessionId, event);
      },
      onStatusChanged: (status) => {
        if (status.state !== 'degraded' && status.state !== 'unavailable') {
          return;
        }
        for (const [sessionId] of this.codexAdapter.getAllClients()) {
          sessionDomainService.setRuntimeSnapshot(
            sessionId,
            {
              phase: 'error',
              processState: 'stopped',
              activity: 'IDLE',
              updatedAt: new Date().toISOString(),
            },
            true
          );
        }
      },
    });
  }

  private normalizeCodexDeltaEvent(sessionId: string, event: SessionDeltaEvent): SessionDeltaEvent {
    if (event.type !== 'agent_message') {
      return event;
    }

    const order = sessionDomainService.appendClaudeEvent(sessionId, event.data);
    return {
      ...event,
      order,
    };
  }

  private isTerminalCodexTurnMethod(method: string): boolean {
    return (
      method.startsWith('turn/completed') ||
      method.startsWith('turn/finished') ||
      method.startsWith('turn/interrupted') ||
      method.startsWith('turn/cancelled') ||
      method.startsWith('turn/failed')
    );
  }

  /**
   * Start a session using the active provider adapter.
   * Uses getOrCreateSessionClient() internally for unified lifecycle management with race protection.
   */
  async startSession(sessionId: string, options?: { initialPrompt?: string }): Promise<void> {
    const loaded = await this.loadSessionWithAdapter(sessionId);
    const { session, adapter } = loaded;
    if (adapter.isStopInProgress(sessionId)) {
      throw new Error('Session is currently being stopped');
    }

    // Check if session is already running to prevent duplicate message sends
    const existingClient = adapter.getClient(sessionId);
    if (existingClient) {
      throw new Error('Session is already running');
    }

    // Use getOrCreateClient for race-protected creation
    // If concurrent starts happen, one will succeed and others will wait then fail the check above
    await this.getOrCreateSessionClient(
      sessionId,
      {
        permissionMode: 'bypassPermissions',
      },
      loaded
    );

    // Send initial prompt - defaults to 'Continue with the task.' if not provided
    const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
    if (initialPrompt) {
      await this.sendSessionMessage(sessionId, initialPrompt);
    }

    logger.info('Session started', { sessionId, provider: session.provider });
  }

  /**
   * Stop a session gracefully via the active provider adapter.
   * All sessions use ClaudeClient for unified lifecycle management.
   */
  async stopSession(
    sessionId: string,
    options?: { cleanupTransientRatchetSession?: boolean; providerHint?: SessionProvider }
  ): Promise<void> {
    const session = await this.loadSessionForStop(sessionId);
    const provider =
      options?.providerHint ??
      session?.provider ??
      this.sessionProviderCache.get(sessionId) ??
      'CLAUDE';
    const adapter = this.resolveAdapterForProvider(provider);

    if (adapter.isStopInProgress(sessionId)) {
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

    try {
      await adapter.stopClient(sessionId);
      await this.updateStoppedSessionState(sessionId);

      sessionDomainService.clearQueuedWork(sessionId, { emitSnapshot: false });

      // Manual stops can complete without an exit callback race; normalize state explicitly.
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });

      const shouldCleanupTransientRatchetSession = options?.cleanupTransientRatchetSession ?? true;
      await this.cleanupTransientRatchetOnStop(
        session,
        sessionId,
        shouldCleanupTransientRatchetSession
      );

      logger.info('Session stopped', { sessionId, provider });
    } finally {
      this.clearSessionProvider(sessionId);
    }
  }

  private async loadSessionForStop(sessionId: string): Promise<AgentSessionRecord | null> {
    try {
      const session = await this.repository.getSessionById(sessionId);
      if (session) {
        this.cacheSessionProvider(sessionId, session.provider);
      }
      return session;
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
        claudeProcessPid: null,
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
      await this.stopWorkspaceSession(
        { id: session.id, status: session.status, provider: session.provider },
        workspaceId
      );
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
    },
    loadedSession?: LoadedSessionAdapter
  ): Promise<unknown> {
    const { session, adapter } = loadedSession ?? (await this.loadSessionWithAdapter(sessionId));

    // Check for existing client first - fast path
    const existing = adapter.getClient(sessionId);
    if (existing) {
      const isWorking = adapter.isSessionWorking(sessionId);
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return existing;
    }

    sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'starting',
      processState: 'alive',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    try {
      const client =
        session.provider === 'CODEX'
          ? await this.createCodexClient(
              sessionId,
              options?.model,
              options?.reasoningEffort,
              session
            )
          : await this.createClaudeClient(sessionId, options, session);

      // Update DB with running status and PID
      // This is idempotent and safe even if called by concurrent callers
      await this.repository.updateSession(sessionId, {
        status: SessionStatus.RUNNING,
        claudeProcessPid:
          session.provider === 'CODEX'
            ? (this.codexAdapter.getManager().getStatus().pid ?? null)
            : ((client as ClaudeClient).getPid?.() ?? null),
      });

      const isWorking = adapter.isSessionWorking(sessionId);
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      });

      return client;
    } catch (error) {
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'error',
        processState: 'stopped',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Backward-compatible Claude-named entrypoint used by existing public contracts.
   */
  async getOrCreateClient(
    sessionId: string,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: 'bypassPermissions' | 'plan';
      model?: string;
      reasoningEffort?: string;
    }
  ): Promise<unknown> {
    return await this.getOrCreateSessionClient(sessionId, options);
  }

  /**
   * Get an existing ClaudeClient without creating one.
   *
   * @param sessionId - The database session ID
   * @returns The ClaudeClient if it exists and is running, undefined otherwise
   */
  getClient(sessionId: string): ClaudeClient | undefined {
    return this.claudeAdapter.getClient(sessionId);
  }

  getSessionClient(sessionId: string): unknown | undefined {
    return this.resolveAdapterForSessionSync(sessionId).getClient(sessionId);
  }

  toPublicMessageDelta(message: ClaudeMessage, order?: number): SessionDeltaEvent {
    return this.claudeAdapter.toPublicDeltaEvent(
      this.claudeAdapter.toCanonicalAgentMessage(message, order)
    );
  }

  async setSessionModel(sessionId: string, model?: string): Promise<void> {
    const { session, adapter } = await this.loadSessionWithAdapter(sessionId);
    const nextModel = resolveSessionModelForProvider(model, session.provider);
    await adapter.setModel(sessionId, nextModel);
  }

  async setSessionReasoningEffort(sessionId: string, effort: string | null): Promise<void> {
    const adapter = this.resolveKnownAdapterForSessionSync(sessionId);
    if (adapter === this.codexAdapter) {
      await this.codexAdapter.setReasoningEffort(sessionId, effort);
      return;
    }
    if (adapter === this.claudeAdapter) {
      return;
    }

    const session = await this.repository.getSessionById(sessionId);
    if (!session || session.provider !== 'CODEX') {
      return;
    }
    await this.codexAdapter.setReasoningEffort(sessionId, effort);
  }

  async setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void> {
    const adapter =
      this.resolveKnownAdapterForSessionSync(sessionId) ??
      (await this.loadSessionWithAdapter(sessionId)).adapter;
    await adapter.setThinkingBudget(sessionId, maxTokens);
  }

  async sendSessionMessage(
    sessionId: string,
    content: string | ClaudeContentItem[]
  ): Promise<void> {
    const adapter = this.resolveKnownAdapterForSessionSync(sessionId);
    if (adapter === this.codexAdapter) {
      const normalizedText = this.toCodexTextContent(content);
      await this.codexAdapter.sendMessage(sessionId, normalizedText);
      return;
    }

    if (adapter === this.claudeAdapter) {
      await this.claudeAdapter.sendMessage(sessionId, content);
      return;
    }

    const { session } = await this.loadSessionWithAdapter(sessionId);
    if (session.provider === 'CODEX') {
      const normalizedText = this.toCodexTextContent(content);
      await this.codexAdapter.sendMessage(sessionId, normalizedText);
      return;
    }
    await this.claudeAdapter.sendMessage(sessionId, content);
  }

  async getSessionConversationHistory(
    sessionId: string,
    workingDir: string
  ): Promise<HistoryMessage[]> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session || session.provider !== 'CLAUDE' || !session.claudeSessionId) {
      return [];
    }
    return await SessionManager.getHistory(session.claudeSessionId, workingDir);
  }

  async tryHydrateCodexTranscript(sessionId: string): Promise<ChatMessage[] | null> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session || session.provider !== 'CODEX') {
      return null;
    }

    const pending = this.codexAdapter.getPendingClient(sessionId);
    if (pending) {
      try {
        await pending;
      } catch (error) {
        logger.debug('Pending Codex client creation failed during hydration', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!this.codexAdapter.getClient(sessionId)) {
      return null;
    }

    try {
      const threadReadPayload = await this.codexAdapter.hydrateSession(sessionId);
      return parseCodexThreadReadTranscript(threadReadPayload);
    } catch (error) {
      logger.warn('Failed to hydrate Codex transcript from thread/read', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async rewindSessionFiles(
    sessionId: string,
    userMessageId: string,
    dryRun?: boolean
  ): Promise<RewindFilesResponse> {
    const { adapter } = await this.loadSessionWithAdapter(sessionId);
    return (await adapter.rewindFiles(sessionId, userMessageId, dryRun)) as RewindFilesResponse;
  }

  respondToPermissionRequest(sessionId: string, requestId: string, allow: boolean): void {
    this.resolveAdapterForSessionSync(sessionId).respondToPermission(sessionId, requestId, allow);
  }

  respondToQuestionRequest(
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): void {
    this.resolveAdapterForSessionSync(sessionId).respondToQuestion(sessionId, requestId, answers);
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    const fallback = createInitialSessionRuntimeState();
    const persisted = sessionDomainService.getRuntimeSnapshot(sessionId);
    const base = persisted ?? fallback;
    const adapter = this.resolveAdapterForSessionSync(sessionId);

    const client = adapter.getClient(sessionId);
    if (client) {
      const isWorking = adapter.isSessionWorking(sessionId);
      return {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      };
    }

    if (adapter.getPendingClient(sessionId) !== undefined) {
      return {
        phase: 'starting',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      };
    }

    if (adapter.isStopInProgress(sessionId)) {
      return {
        ...base,
        phase: 'stopping',
        updatedAt: new Date().toISOString(),
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
        updatedAt: new Date().toISOString(),
      };
    }

    return base;
  }

  private async createClaudeClient(
    sessionId: string,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: 'bypassPermissions' | 'plan';
      model?: string;
    },
    session?: AgentSessionRecord
  ): Promise<ClaudeClient> {
    const { clientOptions, context, handlers } = await this.buildClientOptions(
      sessionId,
      {
        thinkingEnabled: options?.thinkingEnabled,
        permissionMode: options?.permissionMode,
        model: options?.model,
      },
      session
    );

    return await this.claudeAdapter.getOrCreateClient(sessionId, clientOptions, handlers, context);
  }

  private async createCodexClient(
    sessionId: string,
    model?: string,
    reasoningEffort?: string,
    session?: AgentSessionRecord
  ): Promise<unknown> {
    const context = await this.loadCodexSessionContext(sessionId, session);
    const requestedModel = normalizeSessionModelForProvider(model, 'CODEX');
    const clientOptions = {
      workingDir: context.workingDir,
      sessionId,
      model: requestedModel ?? context.model,
      reasoningEffort,
    };
    return await this.codexAdapter.getOrCreateClient(sessionId, clientOptions, {}, context);
  }

  private async loadCodexSessionContext(
    sessionId: string,
    preloadedSession?: AgentSessionRecord
  ): Promise<{
    workspaceId: string;
    workingDir: string;
    model: string;
  }> {
    const session = preloadedSession ?? (await this.repository.getSessionById(sessionId));
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const workspace = await this.repository.getWorkspaceById(session.workspaceId);
    if (!workspace?.worktreePath) {
      throw new Error(`Workspace or worktree not found for session: ${sessionId}`);
    }

    await this.repository.markWorkspaceHasHadSessions(session.workspaceId);
    return {
      workspaceId: session.workspaceId,
      workingDir: workspace.worktreePath,
      model: resolveSessionModelForProvider(session.model, 'CODEX'),
    };
  }

  private toCodexTextContent(content: string | ClaudeContentItem[]): string {
    if (typeof content === 'string') {
      return content;
    }

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
   * Internal: Set up handlers that update DB on client events.
   */
  private buildClientEventHandlers(): ClaudeRuntimeEventHandlers {
    return {
      onSessionId: async (sessionId: string, claudeSessionId: string) => {
        try {
          await this.repository.updateSession(sessionId, { claudeSessionId });
          logger.debug('Updated session with claudeSessionId', { sessionId, claudeSessionId });
        } catch (error) {
          logger.warn('Failed to update session with claudeSessionId', {
            sessionId,
            claudeSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      onExit: async (sessionId: string, exitCode: number | null) => {
        try {
          sessionDomainService.markProcessExit(sessionId, exitCode);
          const session = await this.repository.updateSession(sessionId, {
            status: SessionStatus.COMPLETED,
            claudeProcessPid: null,
          });
          logger.debug('Updated session status to COMPLETED on exit', { sessionId });

          // Eagerly clear stale ratchet fixer reference instead of waiting for next poll.
          // The conditional update is a no-op if this session isn't the active fixer.
          await this.repository.clearRatchetActiveSession(session.workspaceId, sessionId);

          // Ratchet fixer sessions are transient — delete the record to avoid clutter.
          if (session.workflow === 'ratchet') {
            await this.repository.deleteSession(sessionId);
            logger.debug('Deleted transient ratchet session', { sessionId });
          }
        } catch (error) {
          logger.warn('Failed to update session status on exit', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.clearSessionProvider(sessionId);
        }
      },
      onError: (sessionId: string, error: Error) => {
        logger.error('Claude client error', {
          sessionId,
          error: error.message,
          stack: error.stack,
        });
      },
    };
  }

  // ===========================================================================
  // Process Registry Access
  // ===========================================================================

  /**
   * Get an active Claude process from the global registry.
   * Returns a RegisteredProcess interface with status, lifecycle, and resource methods.
   */
  getClaudeProcess(sessionId: string): RegisteredProcess | undefined {
    return this.claudeAdapter.getSessionProcess(sessionId);
  }

  /**
   * Check if a session is running in memory
   */
  isSessionRunning(sessionId: string): boolean {
    return this.resolveAdapterForSessionSync(sessionId).isSessionRunning(sessionId);
  }

  /**
   * Check if a session is actively working (not just alive, but processing)
   */
  isSessionWorking(sessionId: string): boolean {
    return this.resolveAdapterForSessionSync(sessionId).isSessionWorking(sessionId);
  }

  /**
   * Check if any session in the given list is actively working
   */
  isAnySessionWorking(sessionIds: string[]): boolean {
    return (
      this.claudeAdapter.isAnySessionWorking(sessionIds) ||
      this.codexAdapter.isAnySessionWorking(sessionIds)
    );
  }

  /**
   * Get session options for creating a Claude client.
   * Loads the workflow prompt from the database session.
   * This is the single source of truth for session configuration.
   */
  async getSessionOptions(sessionId: string): Promise<{
    workingDir: string;
    resumeClaudeSessionId: string | undefined;
    systemPrompt: string | undefined;
    model: string;
  } | null> {
    const sessionContext = await this.loadSessionContext(sessionId);
    if (!sessionContext) {
      return null;
    }

    return {
      workingDir: sessionContext.workingDir,
      resumeClaudeSessionId: sessionContext.resumeClaudeSessionId,
      systemPrompt: sessionContext.systemPrompt,
      model: sessionContext.model,
    };
  }

  async getChatBarCapabilities(sessionId: string): Promise<ChatBarCapabilities> {
    const { session, adapter } = await this.loadSessionWithAdapter(sessionId);
    const selectedModel =
      session.provider === 'CODEX'
        ? (this.codexAdapter.getPreferredModel(sessionId) ??
          resolveSessionModelForProvider(session.model, session.provider))
        : resolveSessionModelForProvider(session.model, session.provider);
    const selectedReasoningEffort =
      session.provider === 'CODEX'
        ? (this.codexAdapter.getPreferredReasoningEffort(sessionId) ?? null)
        : null;
    return await adapter.getChatBarCapabilities({
      selectedModel,
      selectedReasoningEffort,
    });
  }

  /**
   * Get all active Claude processes for admin view
   */
  getAllActiveProcesses(): Array<{
    sessionId: string;
    pid: number | undefined;
    status: string;
    isRunning: boolean;
    resourceUsage: ResourceUsage | null;
    idleTimeMs: number;
  }> {
    return this.claudeAdapter.getAllActiveProcesses();
  }

  getCodexManagerStatus(): ReturnType<CodexAppServerManager['getStatus']> {
    return this.codexAdapter.getManager().getStatus();
  }

  getAllCodexActiveProcesses(): ReturnType<
    typeof codexSessionProviderAdapter.getAllActiveProcesses
  > {
    return this.codexAdapter.getAllActiveProcesses();
  }

  /**
   * Get all active clients for cleanup purposes.
   * Returns an iterator of [sessionId, client] pairs.
   */
  getAllClients(): IterableIterator<[string, ClaudeClient]> {
    return this.claudeAdapter.getAllClients();
  }

  /**
   * Stop all active clients during shutdown.
   * @param timeoutMs - Timeout for each client stop operation
   */
  async stopAllClients(timeoutMs = 5000): Promise<void> {
    let firstError: unknown = null;

    try {
      await this.claudeAdapter.stopAllClients(timeoutMs);
    } catch (error) {
      firstError = error;
      logger.error('Failed to stop Claude provider clients during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.codexAdapter.stopAllClients();
    } catch (error) {
      if (!firstError) {
        firstError = error;
      }
      logger.error('Failed to stop Codex provider clients during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.sessionProviderCache.clear();

    if (firstError) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
  }

  private shouldStopWorkspaceSession(
    session: Pick<AgentSessionRecord, 'id' | 'status' | 'provider'>,
    adapter: SessionAdapter
  ): {
    shouldStop: boolean;
    pendingClient: Promise<unknown> | undefined;
  } {
    const pendingClient = adapter.getPendingClient(session.id);
    const shouldStop = Boolean(
      session.status === SessionStatus.RUNNING ||
        adapter.isSessionRunning(session.id) ||
        pendingClient
    );
    return { shouldStop, pendingClient };
  }

  private async waitForPendingClient(
    workspaceId: string,
    sessionId: string,
    pendingClient: Promise<unknown> | undefined
  ): Promise<void> {
    if (!pendingClient) {
      return;
    }
    try {
      await pendingClient;
    } catch (error) {
      logger.warn('Pending session failed to start before stop', {
        sessionId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopWorkspaceSession(
    session: Pick<AgentSessionRecord, 'id' | 'status' | 'provider'>,
    workspaceId: string
  ): Promise<void> {
    const adapter = this.resolveAdapterForProvider(session.provider ?? 'CLAUDE');
    const { shouldStop, pendingClient } = this.shouldStopWorkspaceSession(session, adapter);
    if (!shouldStop) {
      return;
    }

    await this.waitForPendingClient(workspaceId, session.id, pendingClient);

    try {
      await this.stopSession(session.id, {
        providerHint: session.provider ?? 'CLAUDE',
      });
    } catch (error) {
      logger.error('Failed to stop workspace session', {
        sessionId: session.id,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async buildClientOptions(
    sessionId: string,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: 'bypassPermissions' | 'plan';
      model?: string;
      initialPrompt?: string;
    },
    session?: AgentSessionRecord
  ): Promise<{
    clientOptions: ClaudeClientOptions;
    context: { workspaceId: string; workingDir: string };
    handlers: ReturnType<SessionService['buildClientEventHandlers']>;
  }> {
    const sessionContext = await this.loadSessionContext(sessionId, session);
    if (!sessionContext) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
    const claudeProjectPath = SessionManager.getProjectPath(sessionContext.workingDir);
    await this.repository.updateSession(sessionId, { claudeProjectPath });

    const mcpConfig = JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest', '--viewport-size=1920,1080'],
        },
      },
    });

    const clientOptions: ClaudeClientOptions = {
      workingDir: sessionContext.workingDir,
      resumeClaudeSessionId: sessionContext.resumeClaudeSessionId,
      systemPrompt: sessionContext.systemPrompt,
      model: resolveSessionModelForProvider(options?.model ?? sessionContext.model, 'CLAUDE'),
      permissionMode: options?.permissionMode ?? 'bypassPermissions',
      includePartialMessages: false,
      thinkingEnabled: options?.thinkingEnabled,
      initialPrompt: options?.initialPrompt,
      mcpConfig,
      sessionId,
    };

    return {
      clientOptions,
      context: { workspaceId: sessionContext.workspaceId, workingDir: sessionContext.workingDir },
      handlers: this.buildClientEventHandlers(),
    };
  }

  private async loadSessionContext(
    sessionId: string,
    preloadedSession?: AgentSessionRecord
  ): Promise<{
    workingDir: string;
    resumeClaudeSessionId: string | undefined;
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
      resumeClaudeSessionId: session.claudeSessionId ?? undefined,
      systemPrompt,
      model: session.model,
      workspaceId: workspace.id,
    };
  }
}

export const sessionService = new SessionService();
