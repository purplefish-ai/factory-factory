import { type ClaudeSession, SessionStatus } from '@prisma-gen/client';
import type { RewindFilesResponse } from '@/backend/domains/session/claude';
import type { ClaudeClient, ClaudeClientOptions } from '@/backend/domains/session/claude/client';
import type { ResourceUsage } from '@/backend/domains/session/claude/process';
import type { RegisteredProcess } from '@/backend/domains/session/claude/registry';
import { SessionManager } from '@/backend/domains/session/claude/session';
import { CodexEventTranslator } from '@/backend/domains/session/codex/codex-event-translator';
import { parseTurnId } from '@/backend/domains/session/codex/payload-utils';
import {
  type ClaudeActiveProcessSummary,
  claudeSessionProviderAdapter,
  codexSessionProviderAdapter,
  type SessionProviderAdapter,
} from '@/backend/domains/session/providers';
import type { ClaudeRuntimeEventHandlers } from '@/backend/domains/session/runtime';
import type { CodexAppServerManager } from '@/backend/domains/session/runtime/codex-app-server-manager';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import type { ClaudeContentItem, ClaudeMessage, SessionDeltaEvent } from '@/shared/claude';
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

type ActiveSessionProviderAdapter = SessionProviderAdapter<
  ClaudeClient,
  ClaudeClientOptions,
  ClaudeRuntimeEventHandlers,
  ClaudeMessage,
  SessionDeltaEvent,
  string | ClaudeContentItem[],
  RewindFilesResponse,
  RegisteredProcess,
  ClaudeActiveProcessSummary
>;

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

class SessionService {
  private readonly repository: SessionRepository;
  private readonly promptBuilder: SessionPromptBuilder;
  private readonly providerAdapter: ActiveSessionProviderAdapter;
  private readonly codexAdapter = codexSessionProviderAdapter;
  private readonly codexEventTranslator = new CodexEventTranslator({
    userInputEnabled: configService.getCodexAppServerConfig().requestUserInputEnabled,
  });

  private getClientWorkingState(client: { isWorking?: () => boolean }): boolean {
    return typeof client.isWorking === 'function' ? client.isWorking() : false;
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

  /**
   * Register a callback to be called when a client is created.
   * Used by chat handler to set up event forwarding without circular dependencies.
   */
  setOnClientCreated(callback: ClientCreatedCallback): void {
    this.providerAdapter.setOnClientCreated(callback);
  }

  constructor(options?: {
    repository?: SessionRepository;
    promptBuilder?: SessionPromptBuilder;
    providerAdapter?: ActiveSessionProviderAdapter;
  }) {
    this.repository = options?.repository ?? sessionRepository;
    this.promptBuilder = options?.promptBuilder ?? sessionPromptBuilder;
    this.providerAdapter = options?.providerAdapter ?? claudeSessionProviderAdapter;
    this.initializeCodexManagerHandlers();
  }

  private initializeCodexManagerHandlers(): void {
    this.codexAdapter.getManager().setHandlers({
      onNotification: ({ sessionId, method, params }) => {
        const registry = this.codexAdapter.getManager().getRegistry();
        if (this.isTerminalCodexTurnMethod(method)) {
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
    if (event.type !== 'claude_message') {
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
   * Uses getOrCreateClient() internally for unified lifecycle management with race protection.
   */
  async startSession(sessionId: string, options?: { initialPrompt?: string }): Promise<void> {
    const session = await this.repository.getSessionById(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (this.providerAdapter.isStopInProgress(sessionId)) {
      throw new Error('Session is currently being stopped');
    }

    // Check if session is already running to prevent duplicate message sends
    const existingClient = this.providerAdapter.getClient(sessionId);
    if (existingClient) {
      throw new Error('Session is already running');
    }

    // Use getOrCreateClient for race-protected creation
    // If concurrent starts happen, one will succeed and others will wait then fail the check above
    await this.getOrCreateSessionClient(sessionId, {
      permissionMode: 'bypassPermissions',
    });

    // Send initial prompt - defaults to 'Continue with the task.' if not provided
    const initialPrompt = options?.initialPrompt ?? 'Continue with the task.';
    if (initialPrompt) {
      await this.providerAdapter.sendMessage(sessionId, initialPrompt);
    }

    logger.info('Session started', { sessionId, provider: 'CLAUDE' });
  }

  /**
   * Backward-compatible Claude-named entrypoint used by existing public contracts.
   */
  async startClaudeSession(sessionId: string, options?: { initialPrompt?: string }): Promise<void> {
    await this.startSession(sessionId, options);
  }

  /**
   * Stop a session gracefully via the active provider adapter.
   * All sessions use ClaudeClient for unified lifecycle management.
   */
  async stopSession(
    sessionId: string,
    options?: { cleanupTransientRatchetSession?: boolean }
  ): Promise<void> {
    if (this.providerAdapter.isStopInProgress(sessionId)) {
      logger.debug('Session stop already in progress', { sessionId });
      return;
    }
    const session = await this.loadSessionForStop(sessionId);

    const current = this.getRuntimeSnapshot(sessionId);
    sessionDomainService.setRuntimeSnapshot(sessionId, {
      ...current,
      phase: 'stopping',
      activity: 'IDLE',
      updatedAt: new Date().toISOString(),
    });

    await this.providerAdapter.stopClient(sessionId);
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

    logger.info('Session stopped', { sessionId, provider: 'CLAUDE' });
  }

  /**
   * Backward-compatible Claude-named entrypoint used by existing public contracts.
   */
  async stopClaudeSession(
    sessionId: string,
    options?: { cleanupTransientRatchetSession?: boolean }
  ): Promise<void> {
    await this.stopSession(sessionId, options);
  }

  private async loadSessionForStop(sessionId: string): Promise<ClaudeSession | null> {
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
    session: ClaudeSession | null,
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
      await this.stopWorkspaceSession(session, workspaceId);
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
    }
  ): Promise<ClaudeClient> {
    // Check for existing client first - fast path
    const existing = this.providerAdapter.getClient(sessionId);
    if (existing) {
      const isWorking = this.getClientWorkingState(existing);
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
      const { clientOptions, context, handlers } = await this.buildClientOptions(sessionId, {
        thinkingEnabled: options?.thinkingEnabled,
        permissionMode: options?.permissionMode,
        model: options?.model,
      });

      const client = await this.providerAdapter.getOrCreateClient(
        sessionId,
        clientOptions,
        handlers,
        context
      );

      // Update DB with running status and PID
      // This is idempotent and safe even if called by concurrent callers
      await this.repository.updateSession(sessionId, {
        status: SessionStatus.RUNNING,
        claudeProcessPid: client.getPid() ?? null,
      });

      const isWorking = this.getClientWorkingState(client);
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
    }
  ): Promise<ClaudeClient> {
    return await this.getOrCreateSessionClient(sessionId, options);
  }

  /**
   * Get an existing ClaudeClient without creating one.
   *
   * @param sessionId - The database session ID
   * @returns The ClaudeClient if it exists and is running, undefined otherwise
   */
  getClient(sessionId: string): ClaudeClient | undefined {
    return this.providerAdapter.getClient(sessionId);
  }

  toPublicMessageDelta(message: ClaudeMessage, order?: number): SessionDeltaEvent {
    return this.providerAdapter.toPublicDeltaEvent(
      this.providerAdapter.toCanonicalAgentMessage(message, order)
    );
  }

  async setSessionModel(sessionId: string, model?: string): Promise<void> {
    await this.providerAdapter.setModel(sessionId, model);
  }

  async setSessionThinkingBudget(sessionId: string, maxTokens: number | null): Promise<void> {
    await this.providerAdapter.setThinkingBudget(sessionId, maxTokens);
  }

  async rewindSessionFiles(
    sessionId: string,
    userMessageId: string,
    dryRun?: boolean
  ): Promise<RewindFilesResponse> {
    return await this.providerAdapter.rewindFiles(sessionId, userMessageId, dryRun);
  }

  respondToPermissionRequest(sessionId: string, requestId: string, allow: boolean): void {
    this.providerAdapter.respondToPermission(sessionId, requestId, allow);
  }

  respondToQuestionRequest(
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): void {
    this.providerAdapter.respondToQuestion(sessionId, requestId, answers);
  }

  getRuntimeSnapshot(sessionId: string): SessionRuntimeState {
    const fallback = createInitialSessionRuntimeState();
    const persisted = sessionDomainService.getRuntimeSnapshot(sessionId);
    const base = persisted ?? fallback;

    const client = this.providerAdapter.getClient(sessionId);
    if (client) {
      const isWorking = this.getClientWorkingState(client);
      return {
        phase: isWorking ? 'running' : 'idle',
        processState: 'alive',
        activity: isWorking ? 'WORKING' : 'IDLE',
        updatedAt: new Date().toISOString(),
      };
    }

    if (this.providerAdapter.getPendingClient(sessionId) !== undefined) {
      return {
        phase: 'starting',
        processState: 'alive',
        activity: 'IDLE',
        updatedAt: new Date().toISOString(),
      };
    }

    if (this.providerAdapter.isStopInProgress(sessionId)) {
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
    return this.providerAdapter.getSessionProcess(sessionId);
  }

  /**
   * Check if a session is running in memory
   */
  isSessionRunning(sessionId: string): boolean {
    return this.providerAdapter.isSessionRunning(sessionId);
  }

  /**
   * Check if a session is actively working (not just alive, but processing)
   */
  isSessionWorking(sessionId: string): boolean {
    return this.providerAdapter.isSessionWorking(sessionId);
  }

  /**
   * Check if any session in the given list is actively working
   */
  isAnySessionWorking(sessionIds: string[]): boolean {
    return this.providerAdapter.isAnySessionWorking(sessionIds);
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
    return this.providerAdapter.getAllActiveProcesses();
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
    return this.providerAdapter.getAllClients();
  }

  /**
   * Stop all active clients during shutdown.
   * @param timeoutMs - Timeout for each client stop operation
   */
  async stopAllClients(timeoutMs = 5000): Promise<void> {
    let firstError: unknown = null;

    try {
      await this.providerAdapter.stopAllClients(timeoutMs);
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

    if (firstError) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
  }

  private shouldStopWorkspaceSession(session: { id: string; status: SessionStatus }): {
    shouldStop: boolean;
    pendingClient: ReturnType<ActiveSessionProviderAdapter['getPendingClient']>;
  } {
    const pendingClient = this.providerAdapter.getPendingClient(session.id);
    const shouldStop = Boolean(
      session.status === SessionStatus.RUNNING ||
        this.providerAdapter.getSessionProcess(session.id) ||
        pendingClient
    );
    return { shouldStop, pendingClient };
  }

  private async waitForPendingClient(
    workspaceId: string,
    sessionId: string,
    pendingClient: ReturnType<ActiveSessionProviderAdapter['getPendingClient']>
  ): Promise<void> {
    if (!pendingClient) {
      return;
    }
    try {
      await pendingClient;
    } catch (error) {
      logger.warn('Pending Claude session failed to start before stop', {
        sessionId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopWorkspaceSession(
    session: { id: string; status: SessionStatus },
    workspaceId: string
  ): Promise<void> {
    const { shouldStop, pendingClient } = this.shouldStopWorkspaceSession(session);
    if (!shouldStop) {
      return;
    }

    await this.waitForPendingClient(workspaceId, session.id, pendingClient);

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

  private async buildClientOptions(
    sessionId: string,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: 'bypassPermissions' | 'plan';
      model?: string;
      initialPrompt?: string;
    }
  ): Promise<{
    clientOptions: ClaudeClientOptions;
    context: { workspaceId: string; workingDir: string };
    handlers: ReturnType<SessionService['buildClientEventHandlers']>;
  }> {
    const sessionContext = await this.loadSessionContext(sessionId);
    if (!sessionContext) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await this.repository.markWorkspaceHasHadSessions(sessionContext.workspaceId);
    const claudeProjectPath = SessionManager.getProjectPath(sessionContext.workingDir);
    await this.repository.updateSession(sessionId, { claudeProjectPath });

    const clientOptions: ClaudeClientOptions = {
      workingDir: sessionContext.workingDir,
      resumeClaudeSessionId: sessionContext.resumeClaudeSessionId,
      systemPrompt: sessionContext.systemPrompt,
      model: options?.model ?? sessionContext.model,
      permissionMode: options?.permissionMode ?? 'bypassPermissions',
      includePartialMessages: false,
      thinkingEnabled: options?.thinkingEnabled,
      initialPrompt: options?.initialPrompt,
      sessionId,
    };

    return {
      clientOptions,
      context: { workspaceId: sessionContext.workspaceId, workingDir: sessionContext.workingDir },
      handlers: this.buildClientEventHandlers(),
    };
  }

  private async loadSessionContext(sessionId: string): Promise<{
    workingDir: string;
    resumeClaudeSessionId: string | undefined;
    systemPrompt: string | undefined;
    model: string;
    workspaceId: string;
  } | null> {
    const session = await this.repository.getSessionById(sessionId);
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
