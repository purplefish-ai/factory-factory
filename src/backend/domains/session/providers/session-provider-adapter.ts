import type { ChatBarCapabilities } from '@/shared/chat-capabilities';
export type SessionProvider = 'CLAUDE' | 'CODEX';

export type CanonicalAgentMessageKind =
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'completion'
  | 'system'
  | 'provider_event';

export interface CanonicalAgentMessageEvent<TData = unknown> {
  type: 'agent_message';
  provider: SessionProvider;
  kind: CanonicalAgentMessageKind;
  order?: number;
  data: TData;
}

export interface SessionProviderAdapter<
  TClient,
  TOptions,
  THandlers,
  TNativeMessage = unknown,
  TPublicDeltaEvent = unknown,
  TSendContent = unknown,
  TRewindResponse = unknown,
  TSessionProcess = unknown,
  TActiveProcessSummary = unknown,
> {
  setOnClientCreated(
    callback: (
      sessionId: string,
      client: TClient,
      context: { workspaceId: string; workingDir: string }
    ) => void
  ): void;
  isStopInProgress(sessionId: string): boolean;
  getOrCreateClient(
    sessionId: string,
    options: TOptions,
    handlers: THandlers,
    context: { workspaceId: string; workingDir: string }
  ): Promise<TClient>;
  getClient(sessionId: string): TClient | undefined;
  getPendingClient(sessionId: string): Promise<TClient> | undefined;
  stopClient(sessionId: string): Promise<void>;
  sendMessage(sessionId: string, content: TSendContent): Promise<void>;
  setModel(sessionId: string, model?: string): Promise<void>;
  setThinkingBudget(sessionId: string, tokens: number | null): Promise<void>;
  rewindFiles(sessionId: string, userMessageId: string, dryRun?: boolean): Promise<TRewindResponse>;
  respondToPermission(sessionId: string, requestId: string, allow: boolean): void;
  respondToQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, string | string[]>
  ): void;
  toCanonicalAgentMessage(
    message: TNativeMessage,
    order?: number
  ): CanonicalAgentMessageEvent<TNativeMessage>;
  toPublicDeltaEvent(event: CanonicalAgentMessageEvent<TNativeMessage>): TPublicDeltaEvent;
  getSessionProcess(sessionId: string): TSessionProcess | undefined;
  isSessionRunning(sessionId: string): boolean;
  isSessionWorking(sessionId: string): boolean;
  isAnySessionWorking(sessionIds: string[]): boolean;
  getAllActiveProcesses(): TActiveProcessSummary[];
  getAllClients(): IterableIterator<[string, TClient]>;
  stopAllClients(timeoutMs?: number): Promise<void>;
  getChatBarCapabilities(options?: {
    selectedModel?: string | null;
    selectedReasoningEffort?: string | null;
  }): Promise<ChatBarCapabilities>;
}
