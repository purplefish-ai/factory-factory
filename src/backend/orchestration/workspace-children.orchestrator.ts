import type { WorkspaceNotification } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { DEFAULT_FOLLOWUP } from '@/backend/prompts/workflows';
import { createLogger } from '@/backend/services/logger.service';
import { sessionDataService, sessionProviderResolverService } from '@/backend/services/session';
import {
  projectManagementService,
  WorkspaceCreationService,
  workspaceDataService,
  workspaceNotificationService,
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
  const project = await projectManagementService.findById(input.projectId);
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
 * Persist a notification from a child workspace to the parent.
 *
 * Always writes a WorkspaceNotification row so the message survives even if a
 * live delivery attempt races a dying session. Callers that deliver live mark
 * the row delivered after a successful dispatch; otherwise it is delivered when
 * the parent's next session starts. Returns the created row, or null if either
 * workspace no longer exists.
 */
export async function persistChildNotification(input: {
  parentWorkspaceId: string;
  sourceWorkspaceId: string;
  message: string;
}): Promise<WorkspaceNotification | null> {
  const [sourceWorkspace, parentWorkspace] = await Promise.all([
    workspaceDataService.findByIdWithProject(input.sourceWorkspaceId),
    workspaceDataService.findById(input.parentWorkspaceId),
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
  });
}

/**
 * Persist a notification from a parent workspace to a specific child.
 *
 * Always writes a WorkspaceNotification row so the message survives even if a
 * live delivery attempt races a dying session. Callers that deliver live mark
 * the row delivered after a successful dispatch; otherwise it is delivered when
 * the child's next session starts. Returns the created row, or null if either
 * workspace no longer exists.
 */
export async function persistParentNotification(input: {
  parentWorkspaceId: string;
  targetChildWorkspaceId: string;
  message: string;
}): Promise<WorkspaceNotification | null> {
  const [parentWorkspace, childWorkspace] = await Promise.all([
    workspaceDataService.findByIdWithProject(input.parentWorkspaceId),
    workspaceDataService.findById(input.targetChildWorkspaceId),
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
  const child = await workspaceDataService.findByIdWithProject(childWorkspaceId);
  if (!child?.parentWorkspaceId) {
    return;
  }

  await persistChildNotification({
    parentWorkspaceId: child.parentWorkspaceId,
    sourceWorkspaceId: childWorkspaceId,
    message,
  });
}
