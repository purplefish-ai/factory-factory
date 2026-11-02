import { createLogger } from '@/backend/services/logger.service';
import { workspaceDataService, workspaceNotificationService } from '@/backend/services/workspace';
import type { WorkspaceMailSendMetadata } from '@/shared/workspace-mail';
import type { WorkspaceNotification } from '@prisma-gen/client';

const logger = createLogger('workspace-notification-persistence');

/**
 * Persist a notification from a child workspace to the parent.
 *
 * Always writes a WorkspaceNotification row so the message survives even if a
 * live wake attempt races a dying session. Bodies stay in the inbox; an explicit
 * acknowledgement is separate from provider wake delivery. Returns null if either
 * workspace no longer exists.
 */
export async function persistChildNotification(
  input: {
    parentWorkspaceId: string;
    sourceWorkspaceId: string;
    message: string;
  } & WorkspaceMailSendMetadata
): Promise<WorkspaceNotification | null> {
  const [sourceWorkspace, parentWorkspace] = await Promise.all([
    workspaceDataService.findByIdWithProject(input.sourceWorkspaceId),
    workspaceDataService.exists(input.parentWorkspaceId),
  ]);

  if (!(sourceWorkspace && parentWorkspace)) {
    logger.warn('persistChildNotification: workspace not found', input);
    return null;
  }

  return workspaceNotificationService.notifyParent({
    workspaceId: input.parentWorkspaceId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    sourceWorkspaceName: sourceWorkspace.name,
    sourceProjectName: sourceWorkspace.project.name,
    message: input.message,
    subject: input.subject,
    kind: input.kind,
    taskKey: input.taskKey,
    taskRevision: input.taskRevision,
  });
}

/**
 * Persist a notification from a parent workspace to a specific child.
 *
 * Always writes a WorkspaceNotification row so the message survives even if a
 * live wake attempt races a dying session. Bodies stay in the inbox; an explicit
 * acknowledgement is separate from provider wake delivery. Returns null if either
 * workspace no longer exists.
 */
export async function persistParentNotification(
  input: {
    parentWorkspaceId: string;
    targetChildWorkspaceId: string;
    message: string;
  } & WorkspaceMailSendMetadata
): Promise<WorkspaceNotification | null> {
  const [parentWorkspace, childWorkspace] = await Promise.all([
    workspaceDataService.findByIdWithProject(input.parentWorkspaceId),
    workspaceDataService.exists(input.targetChildWorkspaceId),
  ]);

  if (!(parentWorkspace && childWorkspace)) {
    logger.warn('persistParentNotification: workspace not found', input);
    return null;
  }

  return workspaceNotificationService.notifyChild({
    workspaceId: input.targetChildWorkspaceId,
    sourceWorkspaceId: input.parentWorkspaceId,
    sourceWorkspaceName: parentWorkspace.name,
    sourceProjectName: parentWorkspace.project.name,
    message: input.message,
    subject: input.subject,
    kind: input.kind,
    taskKey: input.taskKey,
    taskRevision: input.taskRevision,
  });
}
