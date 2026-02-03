import type { WebSocket } from 'ws';
import type { ClaudeClient } from '../../claude/index';
import type { ChatMessageInput } from '../../schemas/websocket';

export interface ClientCreator {
  getOrCreate(
    dbSessionId: string,
    options: {
      thinkingEnabled?: boolean;
      planModeEnabled?: boolean;
      model?: string;
    }
  ): Promise<ClaudeClient>;
}

export interface HandlerContext<T extends ChatMessageInput = ChatMessageInput> {
  ws: WebSocket;
  sessionId: string;
  workingDir: string;
  message: T;
}

export type ChatMessageHandler<T extends ChatMessageInput = ChatMessageInput> = (
  context: HandlerContext<T>
) => Promise<void> | void;

export interface HandlerRegistryDependencies {
  getClientCreator: () => ClientCreator | null;
  tryDispatchNextMessage: (sessionId: string) => Promise<void>;
}
