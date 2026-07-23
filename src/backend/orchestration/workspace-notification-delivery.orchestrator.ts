import { createLogger } from '@/backend/services/logger.service';
import {
  chatMessageHandlerService,
  sessionDataService,
  sessionDomainService,
} from '@/backend/services/session';
import type { AgentMessage } from '@/shared/acp-protocol';
import {
  buildWorkspaceNotificationMessageText,
  workspaceNotificationMessageId,
} from '@/shared/workspace-notifications';
import {
  persistChildNotification,
  persistParentNotification,
} from './workspace-children.orchestrator';

const logger = createLogger('workspace-notification-delivery-orchestrator');

export type WorkspaceNotificationDirection = 'CHILD_TO_PARENT' | 'PARENT_TO_CHILD';

export interface WorkspaceNotificationSource {
  id: string;
  name: string;
  projectName: string;
}

interface WorkspaceNotificationUiEventContext {
  sourceWorkspace: WorkspaceNotificationSource;
  message: string;
  timestamp: string;
}

export interface DeliverWorkspaceNotificationInput {
  direction: WorkspaceNotificationDirection;
  targetWorkspaceId: string;
  sourceWorkspace: WorkspaceNotificationSource;
  message: string;
  buildUiEvent: (context: WorkspaceNotificationUiEventContext) => AgentMessage;
}

export async function deliverWorkspaceNotification(
  input: DeliverWorkspaceNotificationInput
): Promise<{ delivered: boolean }> {
  const notification =
    input.direction === 'CHILD_TO_PARENT'
      ? await persistChildNotification({
          parentWorkspaceId: input.targetWorkspaceId,
          sourceWorkspaceId: input.sourceWorkspace.id,
          message: input.message,
        })
      : await persistParentNotification({
          parentWorkspaceId: input.sourceWorkspace.id,
          targetChildWorkspaceId: input.targetWorkspaceId,
          message: input.message,
        });
  if (!notification) {
    return { delivered: false };
  }

  const sessions = await sessionDataService.findAgentSessionsByWorkspaceId(input.targetWorkspaceId);
  const activeSession = [...sessions]
    .reverse()
    .find((session) => session.status === 'RUNNING' || session.status === 'IDLE');
  if (!activeSession) {
    return { delivered: false };
  }

  const messageId = workspaceNotificationMessageId(notification.id);
  if (sessionDomainService.hasQueuedMessage(activeSession.id, messageId)) {
    return { delivered: true };
  }

  const enqueueResult = sessionDomainService.enqueue(activeSession.id, {
    id: messageId,
    text: buildWorkspaceNotificationMessageText(notification),
    timestamp: new Date().toISOString(),
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  });
  if ('error' in enqueueResult) {
    logger.warn('deliverWorkspaceNotification: live enqueue failed, left pending', {
      direction: input.direction,
      notificationId: notification.id,
      sessionId: activeSession.id,
      error: enqueueResult.error,
    });
    return { delivered: false };
  }

  const uiEvent = input.buildUiEvent({
    sourceWorkspace: input.sourceWorkspace,
    message: input.message,
    timestamp: new Date().toISOString(),
  });
  const order = sessionDomainService.appendClaudeEvent(activeSession.id, uiEvent);
  sessionDomainService.emitDelta(activeSession.id, {
    type: 'agent_message',
    data: uiEvent,
    order,
  });
  // Dispatch fire-and-forget: tryDispatchNextMessage awaits the target session's
  // ENTIRE agent turn (up to the 1h prompt timeout). This function runs behind the
  // sendMessageToChild/sendMessageToParent tRPC mutation, which in turn is the
  // synchronous HTTP request the caller's child-workspace MCP client is blocked on.
  // Awaiting the turn here holds that request open long enough for the external MCP
  // client's own (~5min) tool-call timeout to fire, at which point the agent retries
  // the tool call and a second, non-deduplicable WorkspaceNotification row is
  // persisted — a real duplicate turn (see
  // docs/design/multi-child-workspace-duplicate-messages-analysis.md, H1). Returning
  // as soon as the message is durably queued keeps the mutation fast; the detached
  // dispatch delivers the already-persisted, already-enqueued notification.
  void chatMessageHandlerService.tryDispatchNextMessage(activeSession.id).catch((error) => {
    logger.warn('deliverWorkspaceNotification: detached dispatch failed', {
      direction: input.direction,
      notificationId: notification.id,
      sessionId: activeSession.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return { delivered: true };
}
