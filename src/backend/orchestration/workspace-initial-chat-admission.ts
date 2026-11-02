import { createLogger } from '@/backend/services/logger.service';
import { sessionDomainService } from '@/backend/services/session';
import { type MessageAttachment, MessageState, resolveSelectedModel } from '@/shared/acp-protocol';
import type { WorkspaceInitGuard } from '@/shared/workspace-init-retry';
const logger = createLogger('workspace-initial-chat-admission');
export class InitialChatAdmissionError extends Error {
  constructor(cause: unknown) {
    super('Failed to durably prepare initial chat input', { cause });
  }
}
export async function requireInitialAdmission<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new InitialChatAdmissionError(error);
  }
}

export async function enqueueAutoMessage(
  sessionId: string,
  text: string,
  model: string,
  attachments: MessageAttachment[] | undefined,
  signal: AbortSignal,
  guard?: WorkspaceInitGuard
): Promise<void> {
  const messageId = `auto-init-${sessionId}`;
  const queued = {
    id: messageId,
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    timestamp: new Date().toISOString(),
    settings: {
      selectedModel: model,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  const isCurrent = () => {
    try {
      guard?.assertCurrent();
      return !signal.aborted;
    } catch {
      return false;
    }
  };
  let enqueueResult: Awaited<ReturnType<typeof sessionDomainService.enqueueInitialMessageDurably>> =
    null;
  try {
    enqueueResult = await requireInitialAdmission(() =>
      sessionDomainService.enqueueInitialMessageDurably(sessionId, queued, isCurrent)
    );
    await guard?.check();
    if (!isCurrent()) {
      throw new DOMException('Initial preparation cancelled', 'AbortError');
    }
  } catch (error) {
    // A failed conflicting or identical retry never owns the earlier acceptance.
    if (enqueueResult && !('error' in enqueueResult) && enqueueResult.created) {
      await sessionDomainService
        .cancelInitialMessageDurably(sessionId, messageId)
        .catch((failure) =>
          logger.warn('Failed cancelling interrupted initial input', { sessionId, error: failure })
        );
    }
    throw error;
  }
  if (!enqueueResult) {
    return;
  }
  if ('error' in enqueueResult) {
    throw new InitialChatAdmissionError(new Error(enqueueResult.error));
  } else {
    const acceptedMessage = enqueueResult.message ?? queued;
    sessionDomainService.emitDelta(sessionId, {
      type: 'message_state_changed',
      id: messageId,
      newState: MessageState.ACCEPTED,
      queuePosition: enqueueResult.position,
      userMessage: {
        text: acceptedMessage.text,
        timestamp: acceptedMessage.timestamp,
        attachments: acceptedMessage.attachments,
        settings: {
          ...acceptedMessage.settings,
          selectedModel: resolveSelectedModel(acceptedMessage.settings.selectedModel),
          reasoningEffort: acceptedMessage.settings.reasoningEffort,
        },
      },
    });
  }
}
