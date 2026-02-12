import {
  createUnsupportedOperationError,
  SessionOperationError,
} from '@/backend/domains/session/codex/errors';
import {
  asRecord,
  parseThreadId,
  parseTurnId,
} from '@/backend/domains/session/codex/payload-utils';
import type {
  CodexPendingInteractiveRequest,
  CodexRequestOptions,
} from '@/backend/domains/session/codex/types';
import {
  type CodexAppServerManager,
  codexAppServerManager,
} from '@/backend/domains/session/runtime/codex-app-server-manager';
import { configService } from '@/backend/services/config.service';
import type { SessionDeltaEvent } from '@/shared/claude';
import type {
  CanonicalAgentMessageEvent,
  SessionProviderAdapter,
} from './session-provider-adapter';

export interface CodexClientOptions {
  workingDir: string;
  sessionId: string;
  model?: string;
}

export interface CodexClientHandle {
  sessionId: string;
  threadId: string;
  model?: string;
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
  private readonly preferredModels = new Map<string, string | undefined>();

  private onClientCreated:
    | ((
        sessionId: string,
        client: CodexClientHandle,
        context: { workspaceId: string; workingDir: string }
      ) => void)
    | null = null;

  constructor(private readonly manager: CodexAppServerManager = codexAppServerManager) {}

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

    const createPromise = this.createClient(sessionId, options, context).finally(() => {
      this.pending.delete(sessionId);
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
    let clearSessionError: unknown = null;
    try {
      await this.manager.getRegistry().clearSession(sessionId);
    } catch (error) {
      clearSessionError = error;
    } finally {
      this.clients.delete(sessionId);
      this.preferredModels.delete(sessionId);
      this.stopping.delete(sessionId);
    }

    if (clearSessionError) {
      throw clearSessionError;
    }
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const client = this.requireClient(sessionId);
    const model = this.preferredModels.get(sessionId);
    const result = await this.sendRequest(
      'turn/start',
      {
        threadId: client.threadId,
        input: [{ type: 'text', text: content, text_elements: [] }],
        ...(model ? { model } : {}),
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

  setThinkingBudget(_sessionId: string, _tokens: number | null): Promise<void> {
    return Promise.reject(createUnsupportedOperationError('set_thinking_budget'));
  }

  rewindFiles(_sessionId: string, _userMessageId: string, _dryRun?: boolean): Promise<never> {
    return Promise.reject(createUnsupportedOperationError('rewind_files'));
  }

  respondToPermission(sessionId: string, requestId: string, allow: boolean): void {
    const pending = this.consumePendingRequest(sessionId, requestId);

    this.manager.respond(
      pending.serverRequestId,
      allow
        ? {
            decision: 'accept',
          }
        : {
            decision: 'decline',
          }
    );
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
    const normalizedAnswers = Object.fromEntries(
      Object.entries(answers).map(([questionId, value]) => [
        questionId,
        {
          answers: Array.isArray(value) ? value : [value],
        },
      ])
    );

    this.manager.respond(pending.serverRequestId, {
      answers: normalizedAnswers,
    });
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

    return this.mapCodexEventToDelta(event);
  }

  private mapCodexEventToDelta(
    event: CanonicalAgentMessageEvent<CodexNativeMessage>
  ): SessionDeltaEvent {
    switch (event.kind) {
      case 'assistant_text':
        return this.createAssistantDelta(event.data.text ?? '', 'text', event.order);
      case 'thinking':
        return this.createAssistantDelta(event.data.text ?? '', 'thinking', event.order);
      case 'tool_call':
        return this.createToolCallDelta(event, event.order);
      case 'tool_result':
        return this.createToolResultDelta(event, event.order);
      case 'completion':
        return this.createCompletionDelta(event, event.order);
      default:
        return this.createProviderEventDelta(event, event.order);
    }
  }

  private addOrder<T extends SessionDeltaEvent>(event: T, order?: number): T {
    if (order === undefined) {
      return event;
    }
    return { ...event, order } as T;
  }

  private createAssistantDelta(
    text: string,
    mode: 'text' | 'thinking',
    order?: number
  ): SessionDeltaEvent {
    return this.addOrder(
      {
        type: 'agent_message',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content:
              mode === 'text' ? [{ type: 'text', text }] : [{ type: 'thinking', thinking: text }],
          },
        },
      },
      order
    );
  }

  private createToolCallDelta(
    event: CanonicalAgentMessageEvent<CodexNativeMessage>,
    order?: number
  ): SessionDeltaEvent {
    return this.addOrder(
      {
        type: 'agent_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: event.data.toolUseId ?? 'codex-tool',
              name: event.data.toolName ?? 'codex_tool',
              input: event.data.input ?? {},
            },
          },
        },
      },
      order
    );
  }

  private createToolResultDelta(
    event: CanonicalAgentMessageEvent<CodexNativeMessage>,
    order?: number
  ): SessionDeltaEvent {
    return this.addOrder(
      {
        type: 'agent_message',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: event.data.toolUseId ?? 'codex-tool',
                content: event.data.text ?? JSON.stringify(event.data.payload ?? {}),
              },
            ],
          },
        },
      },
      order
    );
  }

  private createCompletionDelta(
    event: CanonicalAgentMessageEvent<CodexNativeMessage>,
    order?: number
  ): SessionDeltaEvent {
    return this.addOrder(
      {
        type: 'agent_message',
        data: {
          type: 'result',
          result: event.data.payload ?? {},
        },
      },
      order
    );
  }

  private createProviderEventDelta(
    event: CanonicalAgentMessageEvent<CodexNativeMessage>,
    order?: number
  ): SessionDeltaEvent {
    return this.addOrder(
      {
        type: 'agent_message',
        data: {
          type: 'system',
          subtype: 'status',
          status: 'codex_provider_event',
          result: event.data.payload ?? {},
        },
      },
      order
    );
  }

  getSessionProcess(_sessionId: string): ReturnType<CodexAppServerManager['getStatus']> {
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

  async stopAllClients(): Promise<void> {
    let firstCleanupError: unknown = null;
    let stopError: unknown = null;
    try {
      for (const [sessionId] of this.clients) {
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
    context: { workspaceId: string; workingDir: string }
  ): Promise<CodexClientHandle> {
    await this.manager.ensureStarted();

    const registry = this.manager.getRegistry();
    let threadId = await registry.resolveThreadId(sessionId);

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

      await registry.setMappedThreadId(sessionId, threadId);
    } else {
      await this.sendRequest(
        'thread/resume',
        {
          threadId,
        },
        { threadId }
      );
    }

    const client: CodexClientHandle = {
      sessionId,
      threadId,
      model: options.model,
    };

    this.clients.set(sessionId, client);
    this.preferredModels.set(sessionId, options.model);
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
}

export const codexSessionProviderAdapter = new CodexSessionProviderAdapter();
