import { mapCodexMessageToDelta } from '@/backend/domains/session/codex/codex-delta-mapper';
import { CodexModelCatalogService } from '@/backend/domains/session/codex/codex-model-catalog.service';
import {
  createUnsupportedOperationError,
  SessionOperationError,
} from '@/backend/domains/session/codex/errors';
import {
  asRecord,
  parseThreadId,
  parseTurnId,
} from '@/backend/domains/session/codex/payload-utils';
import {
  CodexReasoningEffortSchema,
  validateCodexApprovalResponseWithSchema,
  validateCodexToolRequestUserInputResponseWithSchema,
} from '@/backend/domains/session/codex/schemas';
import type {
  CodexPendingInteractiveRequest,
  CodexRequestOptions,
} from '@/backend/domains/session/codex/types';
import {
  type CodexAppServerManager,
  codexAppServerManager,
} from '@/backend/domains/session/runtime/codex-app-server-manager';
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';
import { createCodexChatBarCapabilities } from '@/shared/chat-capabilities';
import type { SessionDeltaEvent } from '@/shared/claude';
import type {
  CanonicalAgentMessageEvent,
  SessionProviderAdapter,
} from './session-provider-adapter';

export interface CodexClientOptions {
  workingDir: string;
  sessionId: string;
  model?: string;
  reasoningEffort?: string;
}

export interface CodexClientHandle {
  sessionId: string;
  threadId: string;
  model?: string;
  reasoningEffort?: string;
}

export interface CodexNativeMessage {
  kind:
    | 'assistant_text'
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'completion'
    | 'system'
    | 'provider_event';
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface CodexActiveProcessSummary {
  sessionId: string;
  threadId: string;
  pid: number | undefined;
  status: string;
  isRunning: boolean;
  idleTimeMs: number;
}

const logger = createLogger('codex-session-provider-adapter');

export class CodexSessionProviderAdapter
  implements
    SessionProviderAdapter<
      CodexClientHandle,
      CodexClientOptions,
      Record<string, never>,
      CodexNativeMessage,
      SessionDeltaEvent,
      string,
      never,
      ReturnType<CodexAppServerManager['getStatus']>,
      CodexActiveProcessSummary
    >
{
  private readonly clients = new Map<string, CodexClientHandle>();
  private readonly pending = new Map<string, Promise<CodexClientHandle>>();
  private readonly stopping = new Set<string>();
  private readonly lifecycleVersions = new Map<string, number>();
  private readonly preferredModels = new Map<string, string | undefined>();
  private readonly preferredReasoningEfforts = new Map<string, string | undefined>();
  private readonly manager: CodexAppServerManager;
  private readonly modelCatalog: CodexModelCatalogService;

  private onClientCreated:
    | ((
        sessionId: string,
        client: CodexClientHandle,
        context: { workspaceId: string; workingDir: string }
      ) => void)
    | null = null;

  constructor(
    manager: CodexAppServerManager = codexAppServerManager,
    modelCatalog?: CodexModelCatalogService
  ) {
    this.manager = manager;
    this.modelCatalog = modelCatalog ?? new CodexModelCatalogService(manager);
  }

  getManager(): CodexAppServerManager {
    return this.manager;
  }

  setOnClientCreated(
    callback: (
      sessionId: string,
      client: CodexClientHandle,
      context: { workspaceId: string; workingDir: string }
    ) => void
  ): void {
    this.onClientCreated = callback;
  }

  isStopInProgress(sessionId: string): boolean {
    return this.stopping.has(sessionId);
  }

  async getOrCreateClient(
    sessionId: string,
    options: CodexClientOptions,
    _handlers: Record<string, never>,
    context: { workspaceId: string; workingDir: string }
  ): Promise<CodexClientHandle> {
    const existing = this.clients.get(sessionId);
    if (existing) {
      return existing;
    }

    const pendingClient = this.pending.get(sessionId);
    if (pendingClient) {
      return await pendingClient;
    }

    const expectedLifecycleVersion = this.getLifecycleVersion(sessionId);
    const createPromise = this.createClient(
      sessionId,
      options,
      context,
      expectedLifecycleVersion
    ).finally(() => {
      this.pending.delete(sessionId);
      this.maybePruneLifecycleVersion(sessionId);
    });
    this.pending.set(sessionId, createPromise);
    return await createPromise;
  }

  getClient(sessionId: string): CodexClientHandle | undefined {
    return this.clients.get(sessionId);
  }

  getPendingClient(sessionId: string): Promise<CodexClientHandle> | undefined {
    return this.pending.get(sessionId);
  }

  async stopClient(sessionId: string): Promise<void> {
    this.stopping.add(sessionId);
    this.bumpLifecycleVersion(sessionId);
    let clearSessionError: unknown = null;
    try {
      await this.manager.getRegistry().clearSession(sessionId);
    } catch (error) {
      clearSessionError = error;
    } finally {
      this.clients.delete(sessionId);
      this.preferredModels.delete(sessionId);
      this.preferredReasoningEfforts.delete(sessionId);
      this.stopping.delete(sessionId);
      this.maybePruneLifecycleVersion(sessionId);
    }

    if (clearSessionError) {
      throw clearSessionError;
    }
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const client = this.requireClient(sessionId);
    const model = this.preferredModels.get(sessionId);
    const reasoningEffort = this.preferredReasoningEfforts.get(sessionId);
    const result = await this.sendRequest(
      'turn/start',
      {
        threadId: client.threadId,
        input: [{ type: 'text', text: content, text_elements: [] }],
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
      },
      { threadId: client.threadId }
    );

    const turnId = parseTurnId(result);
    if (!turnId) {
      throw new SessionOperationError('Codex turn/start did not return turnId', {
        code: 'CODEX_TURN_ID_MISSING',
        metadata: {
          sessionId,
          threadId: client.threadId,
        },
        retryable: true,
      });
    }
    this.manager.getRegistry().trySetActiveTurnId(sessionId, turnId);
  }

  setModel(sessionId: string, model?: string): Promise<void> {
    this.requireClient(sessionId);
    this.preferredModels.set(sessionId, model);
    return Promise.resolve();
  }

  setReasoningEffort(sessionId: string, effort?: string | null): Promise<void> {
    this.requireClient(sessionId);
    const parsed = CodexReasoningEffortSchema.safeParse(effort);
    if (!parsed.success) {
      this.preferredReasoningEfforts.delete(sessionId);
      return Promise.resolve();
    }
    this.preferredReasoningEfforts.set(sessionId, parsed.data);
    return Promise.resolve();
  }

  setThinkingBudget(_sessionId: string, _tokens: number | null): Promise<void> {
    return Promise.reject(createUnsupportedOperationError('set_thinking_budget'));
  }

  rewindFiles(_sessionId: string, _userMessageId: string, _dryRun?: boolean): Promise<never> {
    return Promise.reject(createUnsupportedOperationError('rewind_files'));
  }

  respondToPermission(sessionId: string, requestId: string, allow: boolean): void {
    const pending = this.consumePendingRequest(sessionId, requestId);
    const validation = validateCodexApprovalResponseWithSchema(pending.method, {
      decision: allow ? 'accept' : 'decline',
    });
    if (!validation.success) {
      throw new SessionOperationError('Codex approval response failed schema validation', {
        code: 'CODEX_APPROVAL_RESPONSE_INVALID',
        metadata: {
          sessionId,
          requestId,
          method: pending.method,
          issues: validation.issues,
        },
      });
    }

    this.manager.respond(pending.serverRequestId, validation.data);
  }

  respondToQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): void {
    if (!configService.getCodexAppServerConfig().requestUserInputEnabled) {
      throw createUnsupportedOperationError('question_response');
    }

    const pending = this.consumePendingRequest(sessionId, requestId);
    const responsePayload = {
      answers: Object.fromEntries(
        Object.entries(answers).map(([questionId, value]) => [
          questionId,
          {
            answers: Array.isArray(value) ? value : [value],
          },
        ])
      ),
    };
    const validation = validateCodexToolRequestUserInputResponseWithSchema(responsePayload);
    if (!validation.success) {
      throw new SessionOperationError('Codex question response failed schema validation', {
        code: 'CODEX_QUESTION_RESPONSE_INVALID',
        metadata: {
          sessionId,
          requestId,
          issues: validation.issues,
        },
      });
    }

    this.manager.respond(pending.serverRequestId, validation.data);
  }

  rejectInteractiveRequest(
    sessionId: string,
    requestId: string,
    reason: { message: string; data?: unknown }
  ): void {
    const pending = this.consumePendingRequest(sessionId, requestId);
    const metadata = asRecord(reason.data);

    this.manager.respond(
      pending.serverRequestId,
      {
        code: typeof metadata.code === 'number' ? metadata.code : -32_601,
        message: reason.message,
        ...(reason.data === undefined ? {} : { data: reason.data }),
      },
      true
    );
  }

  toCanonicalAgentMessage(
    message: CodexNativeMessage,
    order?: number
  ): CanonicalAgentMessageEvent<CodexNativeMessage> {
    return {
      type: 'agent_message',
      provider: 'CODEX',
      kind: message.kind,
      ...(order === undefined ? {} : { order }),
      data: message,
    };
  }

  toPublicDeltaEvent(event: CanonicalAgentMessageEvent<CodexNativeMessage>): SessionDeltaEvent {
    if (event.provider !== 'CODEX') {
      throw new Error(`Cannot map provider ${event.provider} to Codex websocket delta`);
    }

    return mapCodexMessageToDelta(event.data, event.order);
  }

  getSessionProcess(sessionId: string): ReturnType<CodexAppServerManager['getStatus']> | undefined {
    if (!this.clients.has(sessionId)) {
      return undefined;
    }
    return this.manager.getStatus();
  }

  isSessionRunning(sessionId: string): boolean {
    return this.clients.has(sessionId) && this.manager.getStatus().state === 'ready';
  }

  isSessionWorking(sessionId: string): boolean {
    return this.manager.getRegistry().getActiveTurnId(sessionId) !== null;
  }

  isAnySessionWorking(sessionIds: string[]): boolean {
    return sessionIds.some((sessionId) => this.isSessionWorking(sessionId));
  }

  getAllActiveProcesses(): CodexActiveProcessSummary[] {
    const status = this.manager.getStatus();
    return this.manager
      .getRegistry()
      .getBoundSessions()
      .map((binding) => ({
        sessionId: binding.sessionId,
        threadId: binding.threadId,
        pid: status.pid ?? undefined,
        status: status.state,
        isRunning: status.state === 'ready',
        idleTimeMs: this.isSessionWorking(binding.sessionId) ? 0 : 1,
      }));
  }

  getAllClients(): IterableIterator<[string, CodexClientHandle]> {
    return this.clients.entries();
  }

  getPreferredReasoningEffort(sessionId: string): string | undefined {
    return this.preferredReasoningEfforts.get(sessionId);
  }

  getPreferredModel(sessionId: string): string | undefined {
    return this.preferredModels.get(sessionId);
  }

  async getChatBarCapabilities(options?: {
    selectedModel?: string | null;
    selectedReasoningEffort?: string | null;
  }) {
    try {
      const models = await this.modelCatalog.listModels();
      return createCodexChatBarCapabilities({
        selectedModel: options?.selectedModel ?? undefined,
        selectedReasoningEffort: options?.selectedReasoningEffort ?? null,
        models,
      });
    } catch (error) {
      logger.warn('Failed to load Codex model catalog for chat capabilities', {
        error: error instanceof Error ? error.message : String(error),
      });
      return createCodexChatBarCapabilities({
        selectedModel: options?.selectedModel ?? undefined,
        selectedReasoningEffort: options?.selectedReasoningEffort ?? null,
      });
    }
  }

  async stopAllClients(): Promise<void> {
    const sessionIds = new Set<string>([...this.clients.keys(), ...this.pending.keys()]);
    for (const sessionId of sessionIds) {
      this.stopping.add(sessionId);
      this.bumpLifecycleVersion(sessionId);
    }

    let firstCleanupError: unknown = null;
    let stopError: unknown = null;
    try {
      for (const sessionId of sessionIds) {
        try {
          await this.manager.getRegistry().clearSession(sessionId);
        } catch (error) {
          if (!firstCleanupError) {
            firstCleanupError = error;
          }
        }
      }
    } finally {
      this.clients.clear();
      this.preferredModels.clear();
      this.preferredReasoningEfforts.clear();
      for (const sessionId of sessionIds) {
        this.stopping.delete(sessionId);
        this.maybePruneLifecycleVersion(sessionId);
      }
      try {
        await this.manager.stop();
      } catch (error) {
        stopError = error;
      }
    }

    if (firstCleanupError) {
      if (stopError) {
        throw new AggregateError(
          [firstCleanupError, stopError],
          'Codex stopAllClients failed during cleanup and manager shutdown'
        );
      }
      throw firstCleanupError;
    }

    if (stopError) {
      throw stopError;
    }
  }

  async interruptTurn(sessionId: string): Promise<void> {
    const client = this.requireClient(sessionId);
    const turnId = this.manager.getRegistry().getActiveTurnId(sessionId);
    if (!turnId) {
      throw new SessionOperationError(
        `No active Codex turn to interrupt for session: ${sessionId}`,
        {
          code: 'CODEX_ACTIVE_TURN_MISSING',
          metadata: {
            sessionId,
          },
          retryable: true,
        }
      );
    }

    await this.sendRequest(
      'turn/interrupt',
      {
        threadId: client.threadId,
        turnId,
      },
      { threadId: client.threadId }
    );
    this.manager.getRegistry().setActiveTurnId(sessionId, null);
  }

  async hydrateSession(sessionId: string): Promise<unknown> {
    const client = this.requireClient(sessionId);
    return await this.sendRequest(
      'thread/read',
      {
        threadId: client.threadId,
        includeTurns: true,
      },
      { threadId: client.threadId }
    );
  }

  private async createClient(
    sessionId: string,
    options: CodexClientOptions,
    context: { workspaceId: string; workingDir: string },
    expectedLifecycleVersion: number
  ): Promise<CodexClientHandle> {
    await this.manager.ensureStarted();
    this.assertCreationStillCurrent(sessionId, expectedLifecycleVersion, 'after_manager_start');

    const registry = this.manager.getRegistry();
    let threadId = await registry.resolveThreadId(sessionId);
    this.assertCreationStillCurrent(sessionId, expectedLifecycleVersion, 'after_thread_resolve');

    if (!threadId) {
      const result = await this.sendRequest('thread/start', {
        cwd: options.workingDir,
        experimentalRawEvents: false,
        ...(options.model ? { model: options.model } : {}),
      });

      threadId = parseThreadId(result);
      if (!threadId) {
        throw new SessionOperationError('Codex thread/start did not return threadId', {
          code: 'CODEX_THREAD_MAPPING_MISSING',
          metadata: {
            sessionId,
          },
          retryable: true,
        });
      }

      this.assertCreationStillCurrent(sessionId, expectedLifecycleVersion, 'before_thread_bind');
      await registry.setMappedThreadId(sessionId, threadId);
      if (!this.isCreationStillCurrent(sessionId, expectedLifecycleVersion)) {
        await this.clearSessionBindingAfterCancelledCreate(sessionId);
        this.assertCreationStillCurrent(sessionId, expectedLifecycleVersion, 'after_thread_bind');
      }
    } else {
      await this.sendRequest(
        'thread/resume',
        {
          threadId,
        },
        { threadId }
      );
      this.assertCreationStillCurrent(sessionId, expectedLifecycleVersion, 'after_thread_resume');
    }

    this.assertCreationStillCurrent(sessionId, expectedLifecycleVersion, 'before_client_register');
    const client: CodexClientHandle = {
      sessionId,
      threadId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    };

    this.clients.set(sessionId, client);
    this.preferredModels.set(sessionId, options.model);
    const parsedReasoningEffort = CodexReasoningEffortSchema.safeParse(options.reasoningEffort);
    if (parsedReasoningEffort.success) {
      this.preferredReasoningEfforts.set(sessionId, parsedReasoningEffort.data);
    } else {
      this.preferredReasoningEfforts.delete(sessionId);
    }
    this.onClientCreated?.(sessionId, client, context);

    return client;
  }

  private requireClient(sessionId: string): CodexClientHandle {
    const client = this.clients.get(sessionId);
    if (client) {
      return client;
    }

    throw new SessionOperationError(`No active Codex client for session: ${sessionId}`, {
      code: 'CODEX_SESSION_NOT_RUNNING',
      metadata: {
        sessionId,
      },
      retryable: true,
    });
  }

  private consumePendingRequest(
    sessionId: string,
    requestId: string
  ): CodexPendingInteractiveRequest {
    const pending = this.manager
      .getRegistry()
      .consumePendingInteractiveRequest(sessionId, requestId);
    if (pending) {
      return pending;
    }

    throw new SessionOperationError(`No pending Codex interactive request: ${requestId}`, {
      code: 'CODEX_PENDING_REQUEST_NOT_FOUND',
      metadata: {
        sessionId,
        requestId,
      },
      retryable: true,
    });
  }

  private async sendRequest(
    method: string,
    params?: unknown,
    options?: CodexRequestOptions
  ): Promise<unknown> {
    return await this.manager.request(method, params, options);
  }

  private getLifecycleVersion(sessionId: string): number {
    return this.lifecycleVersions.get(sessionId) ?? 0;
  }

  private bumpLifecycleVersion(sessionId: string): void {
    this.lifecycleVersions.set(sessionId, this.getLifecycleVersion(sessionId) + 1);
  }

  private isCreationStillCurrent(sessionId: string, expectedLifecycleVersion: number): boolean {
    return (
      !this.stopping.has(sessionId) &&
      this.getLifecycleVersion(sessionId) === expectedLifecycleVersion
    );
  }

  private assertCreationStillCurrent(
    sessionId: string,
    expectedLifecycleVersion: number,
    stage: string
  ): void {
    if (this.isCreationStillCurrent(sessionId, expectedLifecycleVersion)) {
      return;
    }
    throw new SessionOperationError(`Codex client creation cancelled for session: ${sessionId}`, {
      code: 'CODEX_CLIENT_CREATION_CANCELLED',
      metadata: {
        sessionId,
        stage,
      },
      retryable: true,
    });
  }

  private async clearSessionBindingAfterCancelledCreate(sessionId: string): Promise<void> {
    try {
      await this.manager.getRegistry().clearSession(sessionId);
    } catch (error) {
      logger.warn('Failed clearing session binding after cancelled Codex client create', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private maybePruneLifecycleVersion(sessionId: string): void {
    if (
      this.pending.has(sessionId) ||
      this.clients.has(sessionId) ||
      this.stopping.has(sessionId)
    ) {
      return;
    }
    this.lifecycleVersions.delete(sessionId);
  }
}

export const codexSessionProviderAdapter = new CodexSessionProviderAdapter();
