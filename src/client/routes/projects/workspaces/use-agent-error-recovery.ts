import { useCallback, useMemo, useState } from 'react';
import type { AgentErrorStripProps, useChatWebSocket } from '@/client/features/chat';
import type { ChatMessage } from '@/lib/chat-protocol';
import { getSessionRuntimeErrorMessage, type SessionRuntimeState } from '@/shared/session-runtime';

/** The newest sent (not queued) user message with content, which Retry resends. */
export function findLastResendableUserMessage(
  messages: readonly ChatMessage[],
  queuedMessageIds: ReadonlySet<string>
): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.source !== 'user' || queuedMessageIds.has(message.id)) {
      continue;
    }
    if (message.text?.trim() || message.attachments?.length) {
      return message;
    }
  }
  return null;
}

interface AgentErrorRecoveryInput {
  sessionId: string | null;
  sessionRuntime: SessionRuntimeState;
  messages: readonly ChatMessage[];
  queuedMessageIds: ReadonlySet<string>;
  connected: boolean;
  hasPendingMessages: boolean;
  sendMessage: ReturnType<typeof useChatWebSocket>['sendMessage'];
  restartSession?: () => void;
  isRestartingSession?: boolean;
}

/**
 * Props for the pinned agent error strip, or null when there is no current
 * runtime error (or the user dismissed it).
 *
 * Retry resends the last user message: a failed turn consumed it, and sending
 * restarts a stopped runtime, resuming the provider conversation. Restart reuses
 * the session tab's restart action without sending anything. A dismissal lasts
 * until the error changes or clears.
 */
export function useAgentErrorRecovery({
  sessionId,
  sessionRuntime,
  messages,
  queuedMessageIds,
  connected,
  hasPendingMessages,
  sendMessage,
  restartSession,
  isRestartingSession = false,
}: AgentErrorRecoveryInput): AgentErrorStripProps | null {
  const message =
    sessionRuntime.phase === 'error' ? getSessionRuntimeErrorMessage(sessionRuntime) : null;
  const errorKey = message ? `${sessionId ?? ''}\n${message}` : null;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  if (errorKey === null && dismissedKey !== null) {
    // The error cleared, so the same error appearing again is shown again.
    setDismissedKey(null);
  }

  const lastUserMessage = useMemo(
    () => (message ? findLastResendableUserMessage(messages, queuedMessageIds) : null),
    [message, messages, queuedMessageIds]
  );
  const retry = useCallback(() => {
    if (!lastUserMessage) {
      return;
    }
    sendMessage(lastUserMessage.text ?? '', {
      preserveInput: true,
      attachments: lastUserMessage.attachments ?? [],
    });
  }, [lastUserMessage, sendMessage]);
  const dismiss = useCallback(() => setDismissedKey(errorKey), [errorKey]);

  if (!message || errorKey === dismissedKey) {
    return null;
  }
  return {
    message,
    onRetry: lastUserMessage ? retry : undefined,
    retryDisabled: !connected || hasPendingMessages,
    onRestart: restartSession,
    restartPending: isRestartingSession,
    onDismiss: dismiss,
  };
}
