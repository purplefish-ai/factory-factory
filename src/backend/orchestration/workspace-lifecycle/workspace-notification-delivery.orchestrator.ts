import { createLogger } from '@/backend/services/logger.service';
import {
  sessionDispatchService,
  sessionDataService,
  sessionNotificationDeliveryService,
  sessionDomainService,
} from '@/backend/services/session';
import type { AgentMessage } from '@/shared/acp-protocol';
import type { WorkspaceMailSendMetadata } from '@/shared/workspace-mail';
import {
  persistChildNotification,
  persistParentNotification,
} from './workspace-notification-persistence.orchestrator';

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

export interface DeliverWorkspaceNotificationInput extends WorkspaceMailSendMetadata {
  direction: WorkspaceNotificationDirection;
  targetWorkspaceId: string;
  sourceWorkspace: WorkspaceNotificationSource;
  message: string;
  buildUiEvent: (context: WorkspaceNotificationUiEventContext) => AgentMessage;
}

interface WorkspaceNotificationDispatchDependencies {
  sessionDispatch: Pick<
    typeof sessionDispatchService,
    'tryDispatchNextMessage' | 'steerWorkspaceMailSignal'
  >;
}

const defaultWorkspaceNotificationDispatchDependencies: WorkspaceNotificationDispatchDependencies =
  {
    sessionDispatch: sessionDispatchService,
  };

export async function deliverWorkspaceNotification(
  input: DeliverWorkspaceNotificationInput,
  dependencies: WorkspaceNotificationDispatchDependencies = defaultWorkspaceNotificationDispatchDependencies
): Promise<{ delivered: boolean; queued?: boolean; persisted?: boolean; notificationId?: string }> {
  const notification =
    input.direction === 'CHILD_TO_PARENT'
      ? await persistChildNotification({
          parentWorkspaceId: input.targetWorkspaceId,
          sourceWorkspaceId: input.sourceWorkspace.id,
          message: input.message,
          subject: input.subject,
          kind: input.kind,
          taskKey: input.taskKey,
          taskRevision: input.taskRevision,
        })
      : await persistParentNotification({
          parentWorkspaceId: input.sourceWorkspace.id,
          targetChildWorkspaceId: input.targetWorkspaceId,
          message: input.message,
          subject: input.subject,
          kind: input.kind,
          taskKey: input.taskKey,
          taskRevision: input.taskRevision,
        });
  if (!notification) {
    return { delivered: false };
  }

  let queued = false;
  try {
    ({ queued } = await recoverWorkspaceMail(input.targetWorkspaceId, dependencies));
  } catch (error) {
    logger.warn('Mail persisted; recipient wake recovery deferred', {
      notificationId: notification.id,
      error,
    });
  }
  return { delivered: false, queued, persisted: true, notificationId: notification.id };
}

/** Kicks the recipient's durable body-free wake after send, acknowledgement or startup. */
export async function recoverWorkspaceMail(
  workspaceId: string,
  dependencies: WorkspaceNotificationDispatchDependencies = defaultWorkspaceNotificationDispatchDependencies
): Promise<{ queued: boolean }> {
  const sessions = await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId);
  const activeSession = [...sessions]
    .reverse()
    .find((session) => session.status === 'RUNNING' || session.status === 'IDLE');
  if (!activeSession) {
    return { queued: false };
  }
  const { dispatchableCount } = await sessionNotificationDeliveryService.recoverPending({
    sessionId: activeSession.id,
    workspaceId,
    preferSession: true,
    assertAllowed: () => undefined,
  });
  const signal = sessionDomainService
    .getQueueSnapshot(activeSession.id)
    .find((message) =>
      sessionNotificationDeliveryService.isOwnedMailSignal(
        activeSession.id,
        message.id,
        message.text
      )
    );
  // Native steering and prompt dispatch may await an entire remote operation. A
  // send_mail mutation returns after persistence/queueing, never after that turn.
  if (signal && activeSession.status === 'RUNNING') {
    void dependencies.sessionDispatch
      .steerWorkspaceMailSignal(activeSession.id, signal.id)
      .catch((error) => {
        logger.debug('Mail steering unavailable; signal remains queued for the next turn', {
          sessionId: activeSession.id,
          error,
        });
      });
  } else {
    void dependencies.sessionDispatch.tryDispatchNextMessage(activeSession.id).catch((error) => {
      logger.warn('Workspace mail queue progress deferred', { sessionId: activeSession.id, error });
    });
  }
  return { queued: dispatchableCount > 0 };
}
