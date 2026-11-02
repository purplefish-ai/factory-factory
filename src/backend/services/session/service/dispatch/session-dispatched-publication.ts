import { MessageState, type QueuedMessage, resolveSelectedModel } from '@/shared/acp-protocol';
import { sessionDomainService } from '../session-domain.service';

export function publishDispatchedBatch(
  sessionId: string,
  messages: QueuedMessage[],
  settings: QueuedMessage['settings']
) {
  return messages.map((message) => {
    if (!message.source) {
      message.settings = { ...settings };
    }
    const order = sessionDomainService.allocateOrder(sessionId);
    const userMessage = {
      text: message.text,
      timestamp: message.timestamp,
      attachments: message.attachments,
      settings: {
        ...settings,
        selectedModel: resolveSelectedModel(settings.selectedModel),
      },
      order,
    };
    sessionDomainService.emitDelta(sessionId, {
      type: 'message_state_changed',
      id: message.id,
      newState: MessageState.DISPATCHED,
      userMessage,
    });
    return { message, order, userMessage };
  });
}

export function getPermanentBlockedDispatchReason(workspace: {
  status?: string | null;
  worktreePath?: string | null;
}): string | null {
  if (workspace.status === 'ARCHIVING' || workspace.status === 'ARCHIVED') {
    return 'Workspace is archived or archiving and cannot accept new messages.';
  }

  if (workspace.status === 'FAILED' && !workspace.worktreePath) {
    return 'Workspace setup failed before worktree creation. Retry setup before sending messages.';
  }

  return null;
}
