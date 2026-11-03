import { ApplicationError } from '@/backend/lib/application-error';
import { createLogger } from '@/backend/services/logger.service';
import { type projectManagementService, workspaceDataService } from '@/backend/services/workspace';
import type { UserSettings } from '@prisma-gen/client';
import type {
  ChildWorkspaceLaunchSource,
  WorkspaceLauncher,
} from './workspace-launch.orchestrator';
import { deliverWorkspaceNotification } from './workspace-notification-delivery.orchestrator';
export {
  persistChildNotification,
  persistParentNotification,
} from './workspace-notification-persistence.orchestrator';

const logger = createLogger('workspace-children-orchestrator');

export interface ChildWorkspaceLaunchPorts {
  getSettings: () => Promise<Pick<UserSettings, 'childWorkspacesEnabled'>>;
  findProject: typeof projectManagementService.findById;
  launchWorkspace: WorkspaceLauncher<ChildWorkspaceLaunchSource>;
}

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
export async function createChildWorkspace(
  input: CreateChildWorkspaceInput,
  ports: ChildWorkspaceLaunchPorts
): Promise<string> {
  const settings = await ports.getSettings();
  if (!settings.childWorkspacesEnabled) {
    throw new ApplicationError('PRECONDITION_FAILED', 'Child workspaces are disabled in Settings');
  }

  logger.debug('Creating child workspace', {
    parentWorkspaceId: input.parentWorkspaceId,
    projectId: input.projectId,
  });

  // Validate that the target project is available for new child workspaces
  const project = await ports.findProject(input.projectId);
  if (!project) {
    throw new ApplicationError('NOT_FOUND', `Project not found: ${input.projectId}`);
  }

  if (project.isArchived) {
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      'Cannot create a child workspace in an archived project'
    );
  }

  // WorkspaceCreationService validates parent existence, status, and depth
  const { workspace } = await ports.launchWorkspace({
    type: 'CHILD_WORKSPACE',
    parentWorkspaceId: input.parentWorkspaceId,
    projectId: input.projectId,
    name: input.name,
    description: input.description,
    initialPrompt: input.initialPrompt,
    reportBackOn: input.reportBackOn,
  });

  return workspace.id;
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

  await deliverWorkspaceNotification({
    direction: 'CHILD_TO_PARENT',
    targetWorkspaceId: child.parentWorkspaceId,
    sourceWorkspace: { id: child.id, name: child.name, projectName: child.project.name },
    message,
    kind: 'COMPLETION',
    subject: 'Workspace lifecycle update',
    buildUiEvent: ({ timestamp }) => ({
      type: 'child_workspace_update',
      childWorkspaceId: child.id,
      childWorkspaceName: child.name,
      childProjectName: child.project.name,
      text: message,
      timestamp,
    }),
  });
}
