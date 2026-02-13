import { SessionStatus } from '@factory-factory/core';
import type { AcpClientOptions, AcpProcessHandle } from '@/backend/domains/session/acp';
import {
  AcpEventTranslator,
  AcpPermissionBridge,
  type AcpRuntimeEventHandlers,
  acpRuntimeManager,
} from '@/backend/domains/session/acp';
import type { RewindFilesResponse } from '@/backend/domains/session/claude';
import type { ClaudeClient } from '@/backend/domains/session/claude/client';
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
import type { CodexAppServerManager } from '@/backend/domains/session/runtime/codex-app-server-manager';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { resolveSessionModelForProvider } from '@/backend/lib/session-model';
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
  private readonly acpEventTranslator = new AcpEventTranslator(logger);
  private readonly acpPermissionBridges = new Map<string, AcpPermissionBridge>();
  /** Per-session text accumulation state for ACP streaming (reuses order so frontend upserts). */
  private readonly acpStreamState = new Map<string, { textOrder: number; accText: string }>();
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
          const deltas = this.acpEventTranslator.translateSessionUpdate(update);
          for (const delta of deltas) {
            this.handleAcpDelta(sid, delta);
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
          await this.repository.updateSession(sid, { claudeSessionId: providerSessionId });
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
        // Clean up permission bridge and streaming state on exit
        this.acpStreamState.delete(sid);
        const b = this.acpPermissionBridges.get(sid);
        if (b) {
          b.cancelAll();
          this.acpPermissionBridges.delete(sid);
        }

        try {
          sessionDomainService.markProcessExit(sid, exitCode);
          const session = await this.repository.updateSession(sid, {
            status: SessionStatus.COMPLETED,
            claudeProcessPid: null,
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
          this.clearSessionProvider(sid);
        }
      },
      onError: (sid: string, error: Error) => {
        logger.error('ACP client error', {
          sessionId: sid,
          error: error.message,
          stack: error.stack,
        });
      },
    };
  }

  /**
   * Handle a single translated ACP delta: persist and emit agent_messages,
   * accumulate text chunks, and forward non-message deltas.
   */
  private handleAcpDelta(sid: string, delta: SessionDeltaEvent): void {
    if (delta.type !== 'agent_message') {
      sessionDomainService.emitDelta(sid, delta);
      return;
    }

    const data = (delta as { data: ClaudeMessage }).data;

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

  /**
   * Accumulate ACP assistant text chunks into a single message at a stable order.
   */
  private accumulateAcpText(sid: string, data: ClaudeMessage): void {
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
    const accMsg: ClaudeMessage = {
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
    sessionDomainService.emitDelta(sid, {
      type: 'permission_request',
      requestId,
      toolName: params.toolCall.title ?? 'ACP Tool',
      toolUseId: params.toolCall.toolCallId,
      toolInput: (params.toolCall.rawInput as Record<string, unknown>) ?? {},
      acpOptions: params.options.map((o) => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
    });
    sessionDomainService.setPendingInteractiveRequest(sid, {
      requestId,
      toolName: params.toolCall.title ?? 'ACP Tool',
      toolUseId: params.toolCall.toolCallId,
      input: (params.toolCall.rawInput as Record<string, unknown>) ?? {},
      planContent: null,
      timestamp: new Date().toISOString(),
    });
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
      throw new Error(`Session not found: ${sessionId}`);
    }

    await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);

    const handlers = this.setupAcpEventHandler(sessionId);
    const clientOptions: AcpClientOptions = {
      provider: session?.provider ?? 'CLAUDE',
      workingDir: sessionContext.workingDir,
      model: options?.model ?? sessionContext.model,
      systemPrompt: sessionContext.systemPrompt,
      permissionMode: options?.permissionMode ?? 'bypassPermissions',
      sessionId,
      resumeProviderSessionId: session?.claudeSessionId ?? undefined,
    };

    const handle = await acpRuntimeManager.getOrCreateClient(sessionId, clientOptions, handlers, {
      workspaceId: sessionContext.workspaceId,
      workingDir: sessionContext.workingDir,
    });

    // Emit initial config options so the frontend receives them on session start
    if (handle.configOptions.length > 0) {
      sessionDomainService.emitDelta(sessionId, {
        type: 'config_options_update',
        configOptions: handle.configOptions,
      } as SessionDeltaEvent);
    }

    return handle;
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

    // Check for ACP session first (RUNTIME-06: inherits wiring from stop.handler.ts
    // and session.trpc.ts stopSession mutation -- no separate ACP cancel route needed.
    // stopSession handles both "cancel current prompt" and "terminate session".)
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (acpHandle || acpRuntimeManager.isStopInProgress(sessionId)) {
      // Cancel pending ACP permissions and clean up streaming state
      this.acpStreamState.delete(sessionId);
      const acpBridge = this.acpPermissionBridges.get(sessionId);
      if (acpBridge) {
        acpBridge.cancelAll();
        this.acpPermissionBridges.delete(sessionId);
      }

      if (!acpRuntimeManager.isStopInProgress(sessionId)) {
        await acpRuntimeManager.stopClient(sessionId);
      }
      await this.updateStoppedSessionState(sessionId);
      sessionDomainService.clearQueuedWork(sessionId, { emitSnapshot: false });
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
      logger.info('ACP session stopped', { sessionId });
      this.clearSessionProvider(sessionId);
      return;
    }

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

    // Check for existing legacy client first - sessions already running via
    // legacy managers need to continue working until they exit.
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

    // All new sessions use ACP runtime (Phase 21: unified runtime path)
    return await this.getOrCreateAcpSessionClient(sessionId, options ?? {}, session);
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
    // Check ACP runtime first (not managed by legacy adapters)
    const acpClient = acpRuntimeManager.getClient(sessionId);
    if (acpClient) {
      return acpClient;
    }
    return this.resolveAdapterForSessionSync(sessionId).getClient(sessionId);
  }

  toPublicMessageDelta(message: ClaudeMessage, order?: number): SessionDeltaEvent {
    return this.claudeAdapter.toPublicDeltaEvent(
      this.claudeAdapter.toCanonicalAgentMessage(message, order)
    );
  }

  async setSessionModel(sessionId: string, model?: string): Promise<void> {
    // ACP sessions manage model via config options -- find matching configOption by category
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (acpHandle) {
      const modelOption = acpHandle.configOptions.find((o) => o.category === 'model');
      if (modelOption && model) {
        await this.setSessionConfigOption(sessionId, modelOption.id, model);
      }
      return;
    }
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
    // ACP sessions manage thinking via config options -- find matching configOption by category
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (acpHandle) {
      const thoughtOption = acpHandle.configOptions.find((o) => o.category === 'thought_level');
      if (thoughtOption && maxTokens != null) {
        await this.setSessionConfigOption(sessionId, thoughtOption.id, String(maxTokens));
      }
      return;
    }
    const adapter =
      this.resolveKnownAdapterForSessionSync(sessionId) ??
      (await this.loadSessionWithAdapter(sessionId)).adapter;
    await adapter.setThinkingBudget(sessionId, maxTokens);
  }

  /**
   * Set an ACP config option by ID. Calls the agent SDK and emits the
   * authoritative config_options_update delta to all subscribers.
   */
  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    const configOptions = await acpRuntimeManager.setConfigOption(sessionId, configId, value);
    sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);
  }

  async sendSessionMessage(
    sessionId: string,
    content: string | ClaudeContentItem[]
  ): Promise<void> {
    // Fast path: if adapter is already known, skip DB lookup
    const knownAdapter = this.resolveKnownAdapterForSessionSync(sessionId);
    if (knownAdapter === this.codexAdapter) {
      const normalizedText = this.toCodexTextContent(content);
      await this.codexAdapter.sendMessage(sessionId, normalizedText);
      return;
    }

    // Check for ACP session -- ACP sessions use CLAUDE provider but have
    // no ClaudeClient, so adapter resolution would incorrectly route to claudeAdapter
    const acpClient = acpRuntimeManager.getClient(sessionId);
    if (acpClient) {
      const normalizedText =
        typeof content === 'string' ? content : this.toCodexTextContent(content);
      void this.sendAcpMessage(sessionId, normalizedText).catch((error) => {
        logger.error('ACP prompt failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    // Claude adapter path (or fallback to DB lookup for unknown sessions)
    if (knownAdapter === this.claudeAdapter) {
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

  /**
   * Send a message via ACP runtime. Returns the stop reason from the prompt response.
   * The prompt() call blocks until the turn completes; streaming events arrive
   * concurrently via the AcpClientHandler.sessionUpdate callback.
   */
  async sendAcpMessage(sessionId: string, content: string): Promise<string> {
    sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: 'running',
      processState: 'alive',
      activity: 'WORKING',
      updatedAt: new Date().toISOString(),
    });

    try {
      const result = await acpRuntimeManager.sendPrompt(sessionId, content);
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'idle',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      return result.stopReason;
    } catch (error) {
      sessionDomainService.setRuntimeSnapshot(sessionId, {
        phase: 'error',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Cancel an ongoing ACP prompt mid-turn.
   */
  async cancelAcpPrompt(sessionId: string): Promise<void> {
    await acpRuntimeManager.cancelPrompt(sessionId);
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

  respondToAcpPermission(sessionId: string, requestId: string, optionId: string): boolean {
    const bridge = this.acpPermissionBridges.get(sessionId);
    if (!bridge) {
      return false;
    }
    return bridge.resolvePermission(requestId, optionId);
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
      claudeProcessPid: handle.getPid() ?? null,
    });

    sessionDomainService.setRuntimeSnapshot(sessionId, {
      phase: handle.isPromptInFlight ? 'running' : 'idle',
      processState: 'alive',
      activity: handle.isPromptInFlight ? 'WORKING' : 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    return handle;
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
    if (acpRuntimeManager.isSessionRunning(sessionId)) {
      return true;
    }
    return this.resolveAdapterForSessionSync(sessionId).isSessionRunning(sessionId);
  }

  /**
   * Check if a session is actively working (not just alive, but processing)
   */
  isSessionWorking(sessionId: string): boolean {
    if (acpRuntimeManager.isSessionWorking(sessionId)) {
      return true;
    }
    return this.resolveAdapterForSessionSync(sessionId).isSessionWorking(sessionId);
  }

  /**
   * Check if any session in the given list is actively working
   */
  isAnySessionWorking(sessionIds: string[]): boolean {
    return (
      this.claudeAdapter.isAnySessionWorking(sessionIds) ||
      this.codexAdapter.isAnySessionWorking(sessionIds) ||
      acpRuntimeManager.isAnySessionWorking(sessionIds)
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
    // For ACP sessions, derive capabilities from stored configOptions rather
    // than calling the legacy adapter. This provides accurate capabilities
    // regardless of the underlying provider.
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (acpHandle && acpHandle.configOptions.length > 0) {
      return this.buildAcpChatBarCapabilities(acpHandle);
    }

    // Fallback to legacy adapter path for non-ACP sessions
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
   * Build ChatBarCapabilities from ACP configOptions.
   * Derives model and reasoning capabilities from agent-reported config options.
   */
  private buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    const modelOption = handle.configOptions.find((o) => o.category === 'model');
    const thoughtOption = handle.configOptions.find((o) => o.category === 'thought_level');

    return {
      provider: 'CLAUDE',
      model: {
        enabled: !!modelOption,
        options: [],
        ...(modelOption?.currentValue ? { selected: String(modelOption.currentValue) } : {}),
      },
      reasoning: {
        enabled: false,
        options: [],
      },
      thinking: {
        enabled: !!thoughtOption,
      },
      planMode: { enabled: true },
      attachments: { enabled: true, kinds: ['image', 'text'] },
      slashCommands: { enabled: false },
      usageStats: { enabled: false, contextWindow: false },
      rewind: { enabled: false },
    };
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
    const stopOperations: Array<{ name: string; fn: () => Promise<void> }> = [
      { name: 'Claude', fn: () => this.claudeAdapter.stopAllClients(timeoutMs) },
      { name: 'Codex', fn: () => this.codexAdapter.stopAllClients() },
      { name: 'ACP', fn: () => acpRuntimeManager.stopAllClients() },
    ];

    let firstError: unknown = null;
    for (const op of stopOperations) {
      try {
        await op.fn();
      } catch (error) {
        firstError ??= error;
        logger.error(`Failed to stop ${op.name} provider clients during shutdown`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
