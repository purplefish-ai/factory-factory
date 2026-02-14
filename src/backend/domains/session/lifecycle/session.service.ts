import { SessionStatus } from '@factory-factory/core';
import type { AcpClientOptions, AcpProcessHandle } from '@/backend/domains/session/acp';
import {
  AcpEventTranslator,
  AcpPermissionBridge,
  type AcpRuntimeEventHandlers,
  acpRuntimeManager,
} from '@/backend/domains/session/acp';
import type { SessionWorkspaceBridge } from '@/backend/domains/session/bridges';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import type { AgentSessionRecord } from '@/backend/resource_accessors/agent-session.accessor';
import { createLogger } from '@/backend/services/logger.service';
import { type ChatBarCapabilities, EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
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

class SessionService {
  private readonly repository: SessionRepository;
  private readonly promptBuilder: SessionPromptBuilder;
  private readonly acpEventTranslator = new AcpEventTranslator(logger);
  private readonly acpPermissionBridges = new Map<string, AcpPermissionBridge>();
  /** Per-session text accumulation state for ACP streaming (reuses order so frontend upserts). */
  private readonly acpStreamState = new Map<string, { textOrder: number; accText: string }>();
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
          await this.repository.updateSession(sid, { providerSessionId });
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
        this.sessionToWorkspace.delete(sid);
        const b = this.acpPermissionBridges.get(sid);
        if (b) {
          b.cancelAll();
          this.acpPermissionBridges.delete(sid);
        }

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
    // When configOptions change mid-session, sync the handle and re-emit capabilities
    if (delta.type === 'config_options_update') {
      const acpHandle = acpRuntimeManager.getClient(sid);
      if (acpHandle) {
        const { configOptions } = delta as { configOptions: unknown[] };
        acpHandle.configOptions =
          configOptions as import('@agentclientprotocol/sdk').SessionConfigOption[];
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
    this.sessionToWorkspace.set(sessionId, sessionContext.workspaceId);

    const handlers = this.setupAcpEventHandler(sessionId);
    const clientOptions: AcpClientOptions = {
      provider: session?.provider ?? 'CLAUDE',
      workingDir: sessionContext.workingDir,
      model: options?.model ?? sessionContext.model,
      systemPrompt: sessionContext.systemPrompt,
      permissionMode: options?.permissionMode ?? 'bypassPermissions',
      sessionId,
      resumeProviderSessionId: session?.providerSessionId ?? undefined,
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

    // Re-emit chat_capabilities now that the ACP handle exists.
    // The initial load_session fires before the handle is ready, so the
    // frontend would otherwise be stuck with EMPTY capabilities.
    sessionDomainService.emitDelta(sessionId, {
      type: 'chat_capabilities',
      capabilities: this.buildAcpChatBarCapabilities(handle),
    });

    return handle;
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
    const acpBridge = this.acpPermissionBridges.get(sessionId);
    if (acpBridge) {
      acpBridge.cancelAll();
      this.acpPermissionBridges.delete(sessionId);
    }

    try {
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
    } catch (error) {
      logger.warn('Error stopping ACP session', {
        sessionId,
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

  getSessionClient(sessionId: string): unknown | undefined {
    return acpRuntimeManager.getClient(sessionId);
  }

  async setSessionModel(sessionId: string, model?: string): Promise<void> {
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (acpHandle) {
      const modelOption = acpHandle.configOptions.find((o) => o.category === 'model');
      if (modelOption && model) {
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
    const configOptions = await acpRuntimeManager.setConfigOption(sessionId, configId, value);
    sessionDomainService.emitDelta(sessionId, {
      type: 'config_options_update',
      configOptions,
    } as SessionDeltaEvent);
  }

  sendSessionMessage(sessionId: string, content: string | ClaudeContentItem[]): Promise<void> {
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
   * Normalize ClaudeContentItem[] to a plain text string for ACP.
   */
  private normalizeContentToText(content: ClaudeContentItem[]): string {
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

  private extractMessageText(message: ClaudeMessage): string {
    const content = message.message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .filter((item): item is Extract<ClaudeContentItem, { type: 'text' }> => item.type === 'text')
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
        updatedAt: new Date().toISOString(),
      };
    }

    if (acpRuntimeManager.isStopInProgress(sessionId)) {
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

  getChatBarCapabilities(sessionId: string): ChatBarCapabilities {
    const acpHandle = acpRuntimeManager.getClient(sessionId);
    if (!acpHandle) {
      return EMPTY_CHAT_BAR_CAPABILITIES;
    }
    return this.buildAcpChatBarCapabilities(acpHandle);
  }

  /**
   * Build ChatBarCapabilities entirely from ACP configOptions.
   * No hardcoded fallback — capabilities are derived from what the agent reports.
   */
  private buildAcpChatBarCapabilities(handle: AcpProcessHandle): ChatBarCapabilities {
    const modelOption = handle.configOptions.find((o) => o.category === 'model');
    const thoughtOption = handle.configOptions.find((o) => o.category === 'thought_level');

    return {
      provider: handle.provider === 'CODEX' ? 'CODEX' : 'CLAUDE',
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
