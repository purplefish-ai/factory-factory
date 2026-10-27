import type { WebSocket } from 'ws';
import type {
  SessionCommandConfigService,
  SessionExecutionCommandServices,
  SessionPermissionCommandService,
} from '@/backend/services/session/service/chat/session-command.types';
import type { SessionDispatchStartupService as ChatMessageHandlerStartupService } from '@/backend/services/session/service/dispatch/session-dispatch.types';
import type { AgentContentItem } from '@/shared/acp-protocol';
import type { ChatMessageInput } from '@/shared/websocket';

export interface ChatMessageHandlerRuntimeManager {
  isSessionRunning: (sessionId: string) => boolean;
}

export interface ChatMessageHandlerPromptService {
  sendSessionMessage: (sessionId: string, content: string | AgentContentItem[]) => Promise<void>;
}

export type { SessionDispatchStartupService as ChatMessageHandlerStartupService } from '@/backend/services/session/service/dispatch/session-dispatch.types';

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
  executionServices?: SessionExecutionCommandServices;
  acpRuntimeManager?: ChatMessageHandlerRuntimeManager;
  sessionConfigService?: SessionCommandConfigService;
  sessionPermissionService?: SessionPermissionCommandService;
  sessionService?: ChatMessageHandlerPromptService;
  startupService?: ChatMessageHandlerStartupService;
  tryDispatchNextMessage: (sessionId: string) => Promise<void>;
  setManualDispatchResume: (sessionId: string, resumed: boolean) => void;
  resetDispatchState?: (sessionId: string) => void;
}
