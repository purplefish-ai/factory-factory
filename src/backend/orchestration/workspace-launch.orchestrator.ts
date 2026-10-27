import { ApplicationError } from '@/backend/lib/application-error';
import {
  getProviderUnavailableMessage,
  type ProviderCliHealthStatus,
} from '@/backend/lib/provider-cli-availability';
import type { initializeWorkspaceWorktree } from '@/backend/orchestration/workspace-init.orchestrator';
import type { createLogger } from '@/backend/services/logger.service';
import type {
  sessionDataService,
  sessionProviderResolverService,
} from '@/backend/services/session';
import type { WorkspaceCreationService } from '@/backend/services/workspace';

type WorkspaceCreation = WorkspaceCreationService['create'];

// This concrete adapter owns the interactive policy only. Child and scheduled
// launches retain their own policies and callers.
export type WorkspaceLaunchSource = Extract<
  Parameters<WorkspaceCreation>[0],
  { type: 'MANUAL' | 'RESUME_BRANCH' | 'GITHUB_ISSUE' | 'LINEAR_ISSUE' }
>;
export type CreatedWorkspace = Awaited<ReturnType<WorkspaceCreation>>;

export interface WorkspaceLaunchPorts {
  getMaxSessionsPerWorkspace(): number;
  resolveProvider: typeof sessionProviderResolverService.resolveProviderForWorkspaceCreation;
  checkCliHealth(): Promise<ProviderCliHealthStatus>;
  createWorkspace: WorkspaceCreation;
  createDefaultSession(
    input: Parameters<typeof sessionDataService.createAgentSession>[0]
  ): Promise<{ id: string }>;
  initializeWorktree: typeof initializeWorkspaceWorktree;
  logger: Pick<ReturnType<typeof createLogger>, 'warn' | 'error'>;
}

/** Coordinate interactive launch without taking ownership of persistence or runtime. */
export async function launchWorkspace(
  source: WorkspaceLaunchSource,
  ports: WorkspaceLaunchPorts
): Promise<{ workspace: CreatedWorkspace; defaultSessionId: string | null }> {
  const capacity = ports.getMaxSessionsPerWorkspace();
  let provider: Awaited<ReturnType<WorkspaceLaunchPorts['resolveProvider']>> | undefined;

  // Capacity enables provisioning; it is not a per-workspace session limit check.
  if (capacity > 0) {
    provider = await ports.resolveProvider(
      source.type === 'RESUME_BRANCH' ? undefined : source.provider
    );
    const health = await ports.checkCliHealth();
    const unavailableMessage = getProviderUnavailableMessage(provider, health);
    if (unavailableMessage) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        `Cannot create workspace: ${unavailableMessage}`
      );
    }
  }

  const workspace = await ports.createWorkspace(source);
  let defaultSessionId: string | null = null;
  if (capacity > 0 && provider) {
    try {
      const session = await ports.createDefaultSession({
        workspaceId: workspace.id,
        workflow: 'followup',
        name: 'Chat 1',
        provider,
        providerProjectPath: null,
      });
      defaultSessionId = session.id;
    } catch (error) {
      ports.logger.warn('Failed to create default session for workspace', {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  void ports
    .initializeWorktree(workspace.id, {
      branchName:
        source.type === 'MANUAL' || source.type === 'RESUME_BRANCH' ? source.branchName : undefined,
      useExistingBranch: source.type === 'RESUME_BRANCH',
    })
    .catch((error: unknown) => {
      const initError = error instanceof Error ? error : new Error(String(error));
      ports.logger.error('Unexpected error during background workspace initialization', initError, {
        workspaceId: workspace.id,
      });
    });

  return { workspace, defaultSessionId };
}
