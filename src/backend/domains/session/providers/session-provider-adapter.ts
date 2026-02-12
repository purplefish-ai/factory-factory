import type { ClaudeMessage, SessionDeltaEvent } from '@/shared/claude';

export type SessionProvider = 'CLAUDE' | 'CODEX';

export type CanonicalAgentMessageKind =
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'completion'
  | 'system'
  | 'provider_event';

export interface CanonicalAgentMessageEvent {
  type: 'agent_message';
  provider: SessionProvider;
  kind: CanonicalAgentMessageKind;
  order?: number;
  data: ClaudeMessage;
}

export interface SessionProviderAdapter<TClient, TOptions, THandlers> {
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
  toCanonicalAgentMessage(message: ClaudeMessage, order?: number): CanonicalAgentMessageEvent;
  toPublicDeltaEvent(event: CanonicalAgentMessageEvent): SessionDeltaEvent;
}
