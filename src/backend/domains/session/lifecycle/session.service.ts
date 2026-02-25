import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpRuntimeManager } from '@/backend/domains/session/acp';
import { acpRuntimeManager } from '@/backend/domains/session/acp';
import type { SessionLifecycleWorkspaceBridge } from '@/backend/domains/session/bridges';
import type { SessionDomainService } from '@/backend/domains/session/session-domain.service';
import { sessionDomainService } from '@/backend/domains/session/session-domain.service';
import type { AgentSessionRecord } from '@/backend/resource_accessors/agent-session.accessor';
import { createLogger } from '@/backend/services/logger.service';
import type {
  AgentContentItem,
  AgentMessage,
  ChatMessage,
  HistoryMessage,
} from '@/shared/acp-protocol';
import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
import { AcpEventProcessor } from './acp-event-processor';
import { SessionConfigService } from './session.config.service';
import { SessionLifecycleService } from './session.lifecycle.service';
import { SessionPermissionService } from './session.permission.service';
import type { SessionPromptBuilder } from './session.prompt-builder';
import { sessionPromptBuilder } from './session.prompt-builder';
import { SessionPromptTurnCompletionService } from './session.prompt-turn-completion.service';
import type { SessionRepository } from './session.repository';
import { sessionRepository } from './session.repository';
import { SessionRetryService } from './session.retry.service';

const logger = createLogger('session');
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
  private readonly runtimeManager: AcpRuntimeManager;
  private readonly sessionDomainService: SessionDomainService;
  private readonly sessionPermissionService: SessionPermissionService;
  private readonly sessionConfigService: SessionConfigService;
  private readonly acpEventProcessor: AcpEventProcessor;
  private readonly promptTurnCompletionService: SessionPromptTurnCompletionService;
  private readonly retryService: SessionRetryService;
  private readonly lifecycleService: SessionLifecycleService;
  /** Cross-domain bridge for workspace activity (injected by orchestration layer) */
  private workspaceBridge: SessionLifecycleWorkspaceBridge | null = null;

  constructor(options?: SessionServiceDependencies) {
    this.repository = options?.repository ?? sessionRepository;
    const promptBuilder = options?.promptBuilder ?? sessionPromptBuilder;
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
    this.promptTurnCompletionService = new SessionPromptTurnCompletionService();
    this.retryService = new SessionRetryService();
    this.lifecycleService = new SessionLifecycleService({
      repository: this.repository,
      promptBuilder,
      runtimeManager: this.runtimeManager,
      sessionDomainService: this.sessionDomainService,
      sessionPermissionService: this.sessionPermissionService,
      sessionConfigService: this.sessionConfigService,
      acpEventProcessor: this.acpEventProcessor,
      promptTurnCompletionService: this.promptTurnCompletionService,
      retryService: this.retryService,
    });
  }

  /**
   * Configure cross-domain bridges. Called once at startup by orchestration layer.
   */
  configure(bridges: { workspace: SessionLifecycleWorkspaceBridge }): void {
    this.workspaceBridge = bridges.workspace;
    this.lifecycleService.configure(bridges);
  }

  setPromptTurnCompleteHandler(handler: PromptTurnCompleteHandler | null): void {
    this.promptTurnCompletionService.setHandler(handler);
  }

  async startSession(
    sessionId: string,
    options?: {
      initialPrompt?: string;
      startupModePreset?: SessionStartupModePreset;
    }
  ): Promise<void> {
    await this.lifecycleService.startSession(
      sessionId,
      (id, content) => this.sendSessionMessage(id, content),
      options
    );
  }

  async stopSession(
    sessionId: string,
    options?: { cleanupTransientRatchetSession?: boolean }
  ): Promise<void> {
    await this.lifecycleService.stopSession(sessionId, options);
  }

  async stopWorkspaceSessions(workspaceId: string): Promise<void> {
    await this.lifecycleService.stopWorkspaceSessions(workspaceId);
  }

  getOrCreateSessionClient(
    sessionId: string,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: SessionPermissionMode;
      model?: string;
      reasoningEffort?: string;
    }
  ): Promise<unknown> {
    return this.lifecycleService.getOrCreateSessionClient(sessionId, options);
  }

  getOrCreateSessionClientFromRecord(
    session: AgentSessionRecord,
    options?: {
      thinkingEnabled?: boolean;
      permissionMode?: SessionPermissionMode;
      model?: string;
      reasoningEffort?: string;
    }
  ): Promise<unknown> {
    return this.lifecycleService.getOrCreateSessionClientFromRecord(session, options);
  }

  getSessionClient(sessionId: string): unknown | undefined {
    return this.lifecycleService.getSessionClient(sessionId);
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
      this.promptTurnCompletionService.schedule(sessionId);
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

  getRuntimeSnapshot(sessionId: string) {
    return this.lifecycleService.getRuntimeSnapshot(sessionId);
  }

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

  getSessionOptions(sessionId: string): Promise<{
    workingDir: string;
    resumeProviderSessionId: string | undefined;
    systemPrompt: string | undefined;
    model: string;
  } | null> {
    return this.lifecycleService.getSessionOptions(sessionId);
  }

  getChatBarCapabilities(sessionId: string): Promise<ChatBarCapabilities> {
    return this.sessionConfigService.getChatBarCapabilities(sessionId);
  }

  async stopAllClients(timeoutMs = 5000): Promise<void> {
    await this.lifecycleService.stopAllClients(timeoutMs);
  }
}

export function createSessionService(options?: SessionServiceDependencies): SessionService {
  return new SessionService(options);
}

export const sessionService = createSessionService();
