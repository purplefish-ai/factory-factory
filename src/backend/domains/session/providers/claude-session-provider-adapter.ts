import type { RewindFilesResponse } from '@/backend/domains/session/claude';
import type { ClaudeClient, ClaudeClientOptions } from '@/backend/domains/session/claude/client';
import type { ResourceUsage } from '@/backend/domains/session/claude/process';
import type { RegisteredProcess } from '@/backend/domains/session/claude/registry';
import {
  type ClaudeRuntimeEventHandlers,
  type ClaudeRuntimeManager,
  claudeRuntimeManager,
} from '@/backend/domains/session/runtime';
import { createClaudeChatBarCapabilities } from '@/shared/chat-capabilities';
import {
  type ClaudeContentItem,
  type ClaudeMessage,
  hasToolResultContent,
  type SessionDeltaEvent,
} from '@/shared/claude';
import type {
  CanonicalAgentMessageEvent,
  SessionProviderAdapter,
} from './session-provider-adapter';

export type ClaudeActiveProcessSummary = {
  sessionId: string;
  pid: number | undefined;
  status: string;
  isRunning: boolean;
  resourceUsage: ResourceUsage | null;
  idleTimeMs: number;
};

export class ClaudeSessionProviderAdapter
  implements
    SessionProviderAdapter<
      ClaudeClient,
      ClaudeClientOptions,
      ClaudeRuntimeEventHandlers,
      ClaudeMessage,
      SessionDeltaEvent,
      string | ClaudeContentItem[],
      RewindFilesResponse,
      RegisteredProcess,
      ClaudeActiveProcessSummary
    >
{
  constructor(private readonly runtimeManager: ClaudeRuntimeManager = claudeRuntimeManager) {}

  setOnClientCreated(
    callback: (
      sessionId: string,
      client: ClaudeClient,
      context: { workspaceId: string; workingDir: string }
    ) => void
  ): void {
    this.runtimeManager.setOnClientCreated(callback);
  }

  isStopInProgress(sessionId: string): boolean {
    return this.runtimeManager.isStopInProgress(sessionId);
  }

  getOrCreateClient(
    sessionId: string,
    options: ClaudeClientOptions,
    handlers: ClaudeRuntimeEventHandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<ClaudeClient> {
    return this.runtimeManager.getOrCreateClient(sessionId, options, handlers, context);
  }

  getClient(sessionId: string): ClaudeClient | undefined {
    return this.runtimeManager.getClient(sessionId);
  }

  getPendingClient(sessionId: string): Promise<ClaudeClient> | undefined {
    return this.runtimeManager.getPendingClient(sessionId);
  }

  stopClient(sessionId: string): Promise<void> {
    return this.runtimeManager.stopClient(sessionId);
  }

  getSessionProcess(sessionId: string): RegisteredProcess | undefined {
    return this.runtimeManager.getClaudeProcess(sessionId);
  }

  isSessionRunning(sessionId: string): boolean {
    return this.runtimeManager.isSessionRunning(sessionId);
  }

  isSessionWorking(sessionId: string): boolean {
    return this.runtimeManager.isSessionWorking(sessionId);
  }

  isAnySessionWorking(sessionIds: string[]): boolean {
    return this.runtimeManager.isAnySessionWorking(sessionIds);
  }

  getAllActiveProcesses(): ClaudeActiveProcessSummary[] {
    return this.runtimeManager.getAllActiveProcesses();
  }

  getAllClients(): IterableIterator<[string, ClaudeClient]> {
    return this.runtimeManager.getAllClients();
  }

  stopAllClients(timeoutMs = 5000): Promise<void> {
    return this.runtimeManager.stopAllClients(timeoutMs);
  }

  getChatBarCapabilities(options?: { selectedModel?: string | null }) {
    return createClaudeChatBarCapabilities(options?.selectedModel ?? undefined);
  }

  async sendMessage(sessionId: string, content: string | ClaudeContentItem[]): Promise<void> {
    const client = this.getRequiredClient(sessionId);
    await client.sendMessage(content);
  }

  async setModel(sessionId: string, model?: string): Promise<void> {
    const client = this.getRequiredClient(sessionId);
    await client.setModel(model);
  }

  async setThinkingBudget(sessionId: string, tokens: number | null): Promise<void> {
    const client = this.getRequiredClient(sessionId);
    await client.setMaxThinkingTokens(tokens);
  }

  async rewindFiles(
    sessionId: string,
    userMessageId: string,
    dryRun?: boolean
  ): Promise<RewindFilesResponse> {
    const client = this.getRequiredClient(sessionId);
    return await client.rewindFiles(userMessageId, dryRun);
  }

  respondToPermission(sessionId: string, requestId: string, allow: boolean): void {
    const client = this.getRequiredClient(sessionId);
    if (allow) {
      client.approveInteractiveRequest(requestId);
      return;
    }
    client.denyInteractiveRequest(requestId, 'User denied');
  }

  respondToQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): void {
    const client = this.getRequiredClient(sessionId);
    client.answerQuestion(requestId, answers);
  }

  toCanonicalAgentMessage(
    message: ClaudeMessage,
    order?: number
  ): CanonicalAgentMessageEvent<ClaudeMessage> {
    return {
      type: 'agent_message',
      provider: 'CLAUDE',
      kind: this.resolveMessageKind(message),
      ...(order === undefined ? {} : { order }),
      data: message,
    };
  }

  toPublicDeltaEvent(event: CanonicalAgentMessageEvent<ClaudeMessage>): SessionDeltaEvent {
    if (event.provider !== 'CLAUDE') {
      throw new Error(`Cannot map provider ${event.provider} to Claude websocket delta`);
    }

    return event.order === undefined
      ? ({ type: 'agent_message', data: event.data } as const)
      : ({ type: 'agent_message', data: event.data, order: event.order } as const);
  }

  private resolveMessageKind(
    message: ClaudeMessage
  ): CanonicalAgentMessageEvent<ClaudeMessage>['kind'] {
    switch (message.type) {
      case 'assistant':
        return 'assistant_text';
      case 'result':
        return 'completion';
      case 'system':
        return 'system';
      case 'stream_event':
        return 'provider_event';
      case 'user': {
        const content = message.message?.content;
        if (Array.isArray(content) && hasToolResultContent(content as ClaudeContentItem[])) {
          return 'tool_result';
        }
        return 'provider_event';
      }
      default:
        return 'provider_event';
    }
  }

  private getRequiredClient(sessionId: string): ClaudeClient {
    const client = this.getClient(sessionId);
    if (!client) {
      throw new Error(`No active client for session: ${sessionId}`);
    }
    return client;
  }
}

export const claudeSessionProviderAdapter = new ClaudeSessionProviderAdapter();
