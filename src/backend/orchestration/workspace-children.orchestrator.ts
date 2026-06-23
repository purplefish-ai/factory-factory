import { TRPCError } from '@trpc/server';
import { DEFAULT_FOLLOWUP } from '@/backend/prompts/workflows';
import { createLogger } from '@/backend/services/logger.service';
import { sessionDataService, sessionProviderResolverService } from '@/backend/services/session';
import {
  projectAccessor,
  WorkspaceCreationService,
  workspaceAccessor,
  workspaceNotificationAccessor,
} from '@/backend/services/workspace';
import { initializeWorkspaceWorktree } from './workspace-init.orchestrator';

const logger = createLogger('workspace-children-orchestrator');

const creationService = new WorkspaceCreationService({ logger });

export interface CreateChildWorkspaceInput {
  parentWorkspaceId: string;
  projectId: string;
  name: string;
  description?: string;
  initialPrompt?: string;
  reportBackOn?: string;
}

/**
 * Create a child workspace under a parent workspace, optionally in a different project.
 * Validates the parent/child relationship then delegates to WorkspaceCreationService
 * and fires workspace initialization in the background.
 */
export async function createChildWorkspace(input: CreateChildWorkspaceInput): Promise<string> {
  logger.debug('Creating child workspace', {
    parentWorkspaceId: input.parentWorkspaceId,
    projectId: input.projectId,
  });

  // Validate that the target project exists
  const project = await projectAccessor.findById(input.projectId);
  if (!project) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Project not found: ${input.projectId}` });
  }

  // WorkspaceCreationService validates parent existence, status, and depth
  const workspace = await creationService.create({
    type: 'CHILD_WORKSPACE',
    parentWorkspaceId: input.parentWorkspaceId,
    projectId: input.projectId,
    name: input.name,
    description: input.description,
    initialPrompt: input.initialPrompt,
    reportBackOn: input.reportBackOn,
  });

  // Provision a default agent session so the workspace auto-starts on init
  try {
    const provider = await sessionProviderResolverService.resolveProviderForWorkspaceCreation();
    await sessionDataService.createAgentSession({
      workspaceId: workspace.id,
      workflow: DEFAULT_FOLLOWUP,
      name: 'Chat 1',
      provider,
      providerProjectPath: null,
    });
  } catch (err) {
    logger.warn('Failed to create default session for child workspace', {
      workspaceId: workspace.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fire initialization in the background — same pattern as workspace.create tRPC mutation
  initializeWorkspaceWorktree(workspace.id).catch((err: unknown) => {
    logger.error('Child workspace init failed', { workspaceId: workspace.id, error: err });
  });

  return workspace.id;
}

/**
 * Deliver a notification from a child workspace to the parent.
 *
 * If the parent workspace has an active/idle agent session the notification will be
 * injected live by the caller (tRPC sendMessageToParent). If it does not, this
 * persists the notification so it is delivered when the parent's next session starts.
 */
export async function persistChildNotification(input: {
  parentWorkspaceId: string;
  sourceWorkspaceId: string;
  message: string;
}): Promise<void> {
  const [sourceWorkspace, parentWorkspace] = await Promise.all([
    workspaceAccessor.findByIdWithProject(input.sourceWorkspaceId),
    workspaceAccessor.findRawById(input.parentWorkspaceId),
  ]);

  if (!(sourceWorkspace && parentWorkspace)) {
    logger.warn('persistChildNotification: workspace not found', input);
    return;
  }

  await workspaceNotificationAccessor.create({
    workspaceId: input.parentWorkspaceId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    sourceWorkspaceName: sourceWorkspace.name,
    sourceProjectName: sourceWorkspace.project.name,
    message: input.message,
  });
}

/**
 * Deliver a notification from a parent workspace to a specific child.
 *
 * If the child workspace has an active/idle agent session the notification will be
 * injected live by the caller (tRPC sendMessageToChild). If it does not, this
 * persists the notification so it is delivered when the child's next session starts.
 */
export async function persistParentNotification(input: {
  parentWorkspaceId: string;
  targetChildWorkspaceId: string;
  message: string;
}): Promise<void> {
  const [parentWorkspace, childWorkspace] = await Promise.all([
    workspaceAccessor.findByIdWithProject(input.parentWorkspaceId),
    workspaceAccessor.findRawById(input.targetChildWorkspaceId),
  ]);

  if (!(parentWorkspace && childWorkspace)) {
    logger.warn('persistParentNotification: workspace not found', input);
    return;
  }

  await workspaceNotificationAccessor.create({
    workspaceId: input.targetChildWorkspaceId,
    sourceWorkspaceId: input.parentWorkspaceId,
    sourceWorkspaceName: parentWorkspace.name,
    sourceProjectName: parentWorkspace.project.name,
    message: input.message,
    direction: 'PARENT_TO_CHILD',
  });
}

/**
 * Fire a lifecycle notification from a child workspace to its parent.
 * Used by orchestration layer for automatic events (PR opened/merged, archived).
 * No-op if the child has no parent.
 */
export async function fireLifecycleNotification(
  childWorkspaceId: string,
  message: string
): Promise<void> {
  const child = await workspaceAccessor.findByIdWithProject(childWorkspaceId);
  if (!child?.parentWorkspaceId) {
    return;
  }

  await persistChildNotification({
    parentWorkspaceId: child.parentWorkspaceId,
    sourceWorkspaceId: childWorkspaceId,
    message,
  });
}
