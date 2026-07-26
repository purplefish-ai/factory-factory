import type { WebSocket } from 'ws';
import type { AgentContentItem } from '@/shared/acp-protocol';
import type { ChatMessageInput } from '@/shared/websocket';

export interface ChatMessageHandlerRuntimeManager {
  isSessionRunning: (sessionId: string) => boolean;
}

export interface ChatMessageHandlerPromptService {
  sendSessionMessage: (sessionId: string, content: string | AgentContentItem[]) => Promise<void>;
}

export interface ChatMessageHandlerPermissionService {
  respondToPermission: (
    sessionId: string,
    requestId: string,
    optionId: string,
    answers?: Record<string, string[]>
  ) => boolean;
}

export interface ChatMessageHandlerConfigService {
  setSessionModel: (sessionId: string, model?: string) => Promise<void>;
  setSessionReasoningEffort: (
    sessionId: string,
    reasoningEffort: string | null
  ) => Promise<void> | void;
  getChatBarCapabilities: (sessionId: string) => Promise<unknown>;
}

export interface ClientCreator {
  getOrCreate(
    dbSessionId: string,
    options: {
      thinkingEnabled?: boolean;
      planModeEnabled?: boolean;
      model?: string;
      reasoningEffort?: string;
    }
  ): Promise<unknown>;
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
  acpRuntimeManager?: ChatMessageHandlerRuntimeManager;
  sessionConfigService?: ChatMessageHandlerConfigService;
  sessionPermissionService?: ChatMessageHandlerPermissionService;
  sessionService?: ChatMessageHandlerPromptService;
  getClientCreator: () => ClientCreator | null;
  tryDispatchNextMessage: (sessionId: string) => Promise<void>;
  setManualDispatchResume: (sessionId: string, resumed: boolean) => void;
  resetDispatchState?: (sessionId: string) => void;
}
