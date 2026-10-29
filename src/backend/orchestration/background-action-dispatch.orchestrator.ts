import type { createLogger } from '@/backend/services/logger.service';
import type { PeriodicTaskTimerEvent } from '@/backend/services/periodic-task';
import type { WorkspaceCreationService } from '@/backend/services/workspace';
import type { PRDeliveryRequest } from '@/shared/pr-monitoring';

type PeriodicTaskLaunchSource = Extract<
  Parameters<WorkspaceCreationService['create']>[0],
  { type: 'PERIODIC_TASK' }
>;

export type BackgroundAction =
  | {
      target: 'existing_sessions';
      deliveries: { sessionId: string; request: PRDeliveryRequest }[];
    }
  | { target: 'new_workspace'; event: PeriodicTaskTimerEvent };

export interface ExistingSessionDispatchPorts {
  enqueue(sessionId: string, request: PRDeliveryRequest): { queued: boolean; reason?: string };
  wakeSession(sessionId: string): Promise<void>;
  logger: Pick<ReturnType<typeof createLogger>, 'warn'>;
}

export interface NewWorkspaceDispatchPorts {
  launchWorkspace(source: PeriodicTaskLaunchSource): Promise<{ workspace: { id: string } }>;
}

export type QueuedBackgroundAction = { status: 'queued'; queuedCount: number };
export type LaunchedBackgroundAction = { status: 'launched'; workspaceId: string };

export function dispatchBackgroundAction(
  action: Extract<BackgroundAction, { target: 'existing_sessions' }>,
  ports: ExistingSessionDispatchPorts
): Promise<QueuedBackgroundAction>;
export function dispatchBackgroundAction(
  action: Extract<BackgroundAction, { target: 'new_workspace' }>,
  ports: NewWorkspaceDispatchPorts
): Promise<LaunchedBackgroundAction>;
/** Queue admission and workspace launch do not imply that background work has completed. */
export async function dispatchBackgroundAction(
  action: BackgroundAction,
  ports: ExistingSessionDispatchPorts | NewWorkspaceDispatchPorts
): Promise<QueuedBackgroundAction | LaunchedBackgroundAction> {
  if (action.target === 'existing_sessions' && 'enqueue' in ports) {
    const recipients = new Set<string>();
    let queuedCount = 0;
    for (const { sessionId, request } of action.deliveries) {
      if (ports.enqueue(sessionId, request).queued) {
        queuedCount++;
      }
      recipients.add(sessionId);
    }
    for (const sessionId of recipients) {
      void ports.wakeSession(sessionId).catch((error: unknown) => {
        const workspaceIds = [
          ...new Set(
            action.deliveries
              .filter((delivery) => delivery.sessionId === sessionId)
              .map((delivery) => delivery.request.workspaceId)
          ),
        ];
        ports.logger.warn('Background queue dispatch deferred', { sessionId, workspaceIds, error });
      });
    }
    return { status: 'queued', queuedCount };
  }
  if (action.target === 'new_workspace' && 'launchWorkspace' in ports) {
    const { projectId, name, periodicTaskId, prompt } = action.event;
    const { workspace } = await ports.launchWorkspace({
      type: 'PERIODIC_TASK',
      projectId,
      name,
      periodicTaskId,
      initialPrompt: prompt,
      ratchetEnabled: true,
    });
    return { status: 'launched', workspaceId: workspace.id };
  }
  throw new Error('Background action dispatch capabilities do not match the target');
}
