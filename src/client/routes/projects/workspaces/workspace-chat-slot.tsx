import { useMemo } from 'react';
import {
  type TranscriptPosition,
  type UseChatWebSocketReturn,
  useChatSessionState,
} from '@/client/features/chat';
import { WorkspaceChatImageDropZone } from './workspace-chat-image-drop-zone';
import { ChatContent, type ChatContentProps } from './workspace-detail-chat-content';
import { hasUserMessageWithoutAgentMessage } from './workspace-detail-container.utils';

/** Props the chat takes from its session rather than from the workspace. */
type SessionContentProps =
  | Exclude<keyof UseChatWebSocketReturn, 'inputRef'>
  | 'history'
  | 'transcriptScroll'
  | 'autoStartPending';

export interface WorkspaceChatProps extends Omit<ChatContentProps, SessionContentProps> {
  /** The workspace was created from a GitHub issue, whose first prompt starts the agent. */
  issueAutoStart: boolean;
  /** The chat is the visible main pane. */
  active: boolean;
  /** The transcript position saved for this session. */
  position: {
    ready: boolean;
    initialPosition: TranscriptPosition | null;
    onPositionChange: (position: TranscriptPosition) => void;
  };
}

/**
 * The selected session's chat. It reads the session from `ChatSessionProvider`,
 * so a streamed event re-renders this component and not the workspace layout
 * around it.
 */
export function WorkspaceChat({ issueAutoStart, active, position, ...props }: WorkspaceChatProps) {
  const session = useChatSessionState();
  const { workspaceId, sessionId } = props;

  // The chat state can still describe the previous session for a render after a
  // switch, so the transcript waits for the selected session's hydration.
  const ready = position.ready && sessionId !== null && session.runtimeSessionId === sessionId;
  const { initialPosition, onPositionChange } = position;
  const transcriptScroll = useMemo(
    () => ({
      identity: `${workspaceId}/main/${sessionId ?? 'none'}`,
      active,
      ready,
      initialIntent: 'following' as const,
      initialPosition,
      onPositionChange,
    }),
    [workspaceId, sessionId, active, ready, initialPosition, onPositionChange]
  );

  const phase = session.sessionStatus.phase;
  const autoStartPending =
    issueAutoStart &&
    sessionId !== null &&
    (phase === 'loading' || phase === 'ready') &&
    session.processStatus.state === 'unknown' &&
    hasUserMessageWithoutAgentMessage(session.messages);

  const content: ChatContentProps = {
    ...props,
    messages: session.messages,
    history: session.transcriptHistory,
    transcriptPageBoundaries: session.transcriptPageBoundaries,
    acpPlan: session.acpPlan,
    sessionStatus: session.sessionStatus,
    sessionRuntime: session.sessionRuntime,
    transcriptScroll,
    pendingRequest: session.pendingRequest,
    approvePermission: session.approvePermission,
    answerQuestion: session.answerQuestion,
    connected: session.connected,
    controlsHydrated: session.controlsHydrated,
    sendMessage: session.sendMessage,
    stopChat: session.stopChat,
    restartSession: session.restartSession,
    isRestartingSession: session.isRestartingSession,
    chatSettings: session.chatSettings,
    chatCapabilities: session.chatCapabilities,
    chatCapabilitiesLoaded: session.chatCapabilitiesLoaded,
    updateSettings: session.updateSettings,
    inputDraft: session.inputDraft,
    setInputDraft: session.setInputDraft,
    inputAttachments: session.inputAttachments,
    inputDraftGeneration: session.inputDraftGeneration,
    setInputAttachments: session.setInputAttachments,
    queuedMessages: session.queuedMessages,
    removeQueuedMessage: session.removeQueuedMessage,
    pendingSteer: session.pendingSteer,
    steerQueuedMessage: session.steerQueuedMessage,
    resumeQueuedMessages: session.resumeQueuedMessages,
    latestThinking: session.latestThinking,
    pendingMessages: session.pendingMessages,
    isCompacting: session.isCompacting,
    slashCommands: session.slashCommands,
    slashCommandsLoaded: session.slashCommandsLoaded,
    tokenStats: session.tokenStats,
    acpConfigOptions: session.acpConfigOptions,
    setConfigOption: session.setConfigOption,
    autoStartPending,
  };
  return (
    <WorkspaceChatImageDropZone {...content}>
      <ChatContent {...content} />
    </WorkspaceChatImageDropZone>
  );
}
