// Components
export { ChatTranscript } from './chat-transcript';
export type { ChatTranscriptProps } from './chat-transcript';
export type { TranscriptPosition, TranscriptScrollOptions } from './transcript-scroll.types';

// Types
export type { ChatMessage } from '@/lib/chat-protocol';
// The transcript renderers. They live under ./agent-activity because their only
// consumer is this feature's own message list; the one exception is the closed-
// session transcript in `workspace`, which is why this name is re-exported.
export { GroupedMessageItemRenderer } from './agent-activity';
export type { ChatInputProps } from './chat-input/chat-input';
export { ChatInput } from './chat-input/chat-input';
export { CompactingIndicator } from './compacting-indicator';
export { PermissionPrompt, PermissionPromptExpanded } from './permission-prompt';
export { projectAcpTranscriptUpdates } from './project-acp-transcript';
export { QuestionPrompt } from './question-prompt';
export { QueuedMessages } from './queued-messages';
export type { TaskNotification } from './reducer';
export type { RewindConfirmationDialogProps } from './rewind-confirmation-dialog';
export { RewindConfirmationDialog } from './rewind-confirmation-dialog';
export type { SessionData } from './session-tab-bar';
export { SessionTabBar } from './session-tab-bar';
export { TodoPanel } from './todo-panel';
// Hooks
export type { UseChatWebSocketOptions, UseChatWebSocketReturn } from './use-chat-websocket';
export { useChatWebSocket } from './use-chat-websocket';
export { useGroupedChatMessages } from './use-grouped-chat-messages';
export { useSessionCollectionCommands } from './use-session-collection-commands';
export type { Todo, TodoState } from './use-todo-tracker';
export { useTodoTracker } from './use-todo-tracker';
