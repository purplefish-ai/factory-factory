import { ApplicationError } from '@/backend/lib/application-error';
import { toError } from '@/backend/lib/error-utils';
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
import type { SessionLaunchOptions, SessionLaunchSettings } from '@/shared/session-launch';

type WorkspaceCreation = WorkspaceCreationService['create'];

export type WorkspaceLaunchSource = Parameters<WorkspaceCreation>[0];
export type ChildWorkspaceLaunchSource = Extract<
  WorkspaceLaunchSource,
  { type: 'CHILD_WORKSPACE' }
>;
export type PeriodicTaskLaunchSource = Extract<WorkspaceLaunchSource, { type: 'PERIODIC_TASK' }>;
type InteractiveLaunchSource = Exclude<
  WorkspaceLaunchSource,
  ChildWorkspaceLaunchSource | PeriodicTaskLaunchSource
>;
export type WorkspaceLaunchResult = {
  workspace: CreatedWorkspace;
  defaultSessionId: string | null;
};
export type WorkspaceLauncher<Source extends WorkspaceLaunchSource = WorkspaceLaunchSource> = (
  source: Source
) => Promise<WorkspaceLaunchResult>;
export type CreatedWorkspace = Awaited<ReturnType<WorkspaceCreation>>;

export interface WorkspaceLaunchPorts {
  getMaxSessionsPerWorkspace(): number;
  resolveProvider: typeof sessionProviderResolverService.resolveProviderForWorkspaceCreation;
  checkCliHealth(): Promise<ProviderCliHealthStatus>;
  getLaunchOptions(input: {
    provider: 'CLAUDE' | 'CODEX';
    model?: string;
    codexAccountId?: string;
  }): Promise<SessionLaunchOptions>;
  validateCodexAccount?(input: { accountId?: string; model?: string }): Promise<unknown>;
  createWorkspace: WorkspaceCreation;
  createDefaultSession(
    input: Parameters<typeof sessionDataService.createAgentSession>[0]
  ): Promise<{ id: string }>;
  initializeWorktree: typeof initializeWorkspaceWorktree;
  logger: Pick<ReturnType<typeof createLogger>, 'warn' | 'error'>;
}

/** Select the source policy; persistence and runtime remain with their capsule owners. */
export function launchWorkspace(
  source: WorkspaceLaunchSource,
  ports: WorkspaceLaunchPorts
): Promise<WorkspaceLaunchResult> {
  switch (source.type) {
    case 'CHILD_WORKSPACE':
      return launchChildWorkspace(source, ports);
    case 'PERIODIC_TASK':
      return launchPeriodicTask(source, ports);
    default:
      return launchInteractiveWorkspace(source, ports);
  }
}

type PersistedLaunchPorts = Pick<
  WorkspaceLaunchPorts,
  'createWorkspace' | 'createDefaultSession' | 'initializeWorktree' | 'logger'
>;

async function launchChildWorkspace(
  source: ChildWorkspaceLaunchSource,
  ports: PersistedLaunchPorts & Pick<WorkspaceLaunchPorts, 'resolveProvider'>
): Promise<WorkspaceLaunchResult> {
  const workspace = await ports.createWorkspace(source);
  let defaultSessionId: string | null = null;
  try {
    const provider = await ports.resolveProvider();
    const session = await ports.createDefaultSession({
      workspaceId: workspace.id,
      workflow: 'followup',
      name: 'Chat 1',
      provider,
      providerProjectPath: null,
    });
    defaultSessionId = session.id;
  } catch (error) {
    ports.logger.warn('Failed to create default session for child workspace', {
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void ports.initializeWorktree(workspace.id).catch((error: unknown) => {
    ports.logger.error('Child workspace init failed', { workspaceId: workspace.id, error });
  });
  return { workspace, defaultSessionId };
}

async function launchPeriodicTask(
  source: PeriodicTaskLaunchSource,
  ports: PersistedLaunchPorts
): Promise<WorkspaceLaunchResult> {
  const workspace = await ports.createWorkspace(source);
  // Required provisioning: retain the persisted workspace on failure and do not initialize it.
  const session = await ports.createDefaultSession({
    workspaceId: workspace.id,
    workflow: 'periodic-task',
    name: 'Agent',
  });
  void ports.initializeWorktree(workspace.id).catch((error: unknown) => {
    ports.logger.error('Failed to initialize workspace for periodic task', toError(error), {
      workspaceId: workspace.id,
    });
  });
  return { workspace, defaultSessionId: session.id };
}

function explicitSessionModel(
  source: InteractiveLaunchSource
): SessionLaunchSettings & { model?: string; codexAccountId?: string } {
  if (source.type !== 'MANUAL') {
    return {};
  }
  return {
    ...(source.model !== undefined ? { model: source.model } : {}),
    ...(source.accessMode !== undefined ? { accessMode: source.accessMode } : {}),
    ...(source.codexAccountId !== undefined ? { codexAccountId: source.codexAccountId } : {}),
    ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
    ...(source.planModeEnabled !== undefined ? { planModeEnabled: source.planModeEnabled } : {}),
  };
}

async function preflightInteractiveLaunch(
  source: InteractiveLaunchSource,
  capacity: number,
  ports: WorkspaceLaunchPorts
): Promise<Awaited<ReturnType<WorkspaceLaunchPorts['resolveProvider']>> | undefined> {
  const { model, accessMode, codexAccountId } = explicitSessionModel(source);
  if (
    capacity <= 0 &&
    model === undefined &&
    accessMode === undefined &&
    codexAccountId === undefined
  ) {
    return undefined;
  }
  const provider = await ports.resolveProvider(
    source.type === 'RESUME_BRANCH' ? undefined : source.provider,
    ...(model === undefined ? ([] as const) : ([model] as const))
  );
  if (codexAccountId !== undefined && provider !== 'CODEX') {
    throw new ApplicationError(
      'INVALID_INPUT',
      'A Codex account can only be selected for a Codex conversation'
    );
  }
  if (capacity > 0) {
    const health = await ports.checkCliHealth();
    const unavailableMessage = getProviderUnavailableMessage(provider, health, {
      accountScopedCodex: ports.validateCodexAccount !== undefined,
    });
    if (unavailableMessage) {
      throw new ApplicationError(
        'PRECONDITION_FAILED',
        `Cannot create workspace: ${unavailableMessage}`
      );
    }
  }
  await validateLaunchAccount({ provider, accountId: codexAccountId, model }, ports);
  await validateLaunchAccess({ provider, model, accessMode, codexAccountId }, ports);
  return provider;
}

async function validateLaunchAccount(
  input: { provider: 'CLAUDE' | 'CODEX'; accountId?: string; model?: string },
  ports: Pick<WorkspaceLaunchPorts, 'validateCodexAccount'>
): Promise<void> {
  if (input.provider !== 'CODEX') {
    return;
  }
  try {
    await ports.validateCodexAccount?.({ accountId: input.accountId, model: input.model });
  } catch (error) {
    if (error instanceof ApplicationError) {
      throw error;
    }
    throw new ApplicationError(
      'PRECONDITION_FAILED',
      error instanceof Error ? error.message : 'Codex account is unavailable',
      { cause: error }
    );
  }
}

async function validateLaunchAccess(
  input: SessionLaunchSettings & {
    provider: 'CLAUDE' | 'CODEX';
    model?: string;
    codexAccountId?: string;
  },
  ports: Pick<WorkspaceLaunchPorts, 'getLaunchOptions'>
): Promise<void> {
  const { provider, model, accessMode, codexAccountId } = input;
  if (accessMode !== undefined) {
    const options = await ports.getLaunchOptions({
      provider,
      model,
      ...(provider === 'CODEX' && codexAccountId ? { codexAccountId } : {}),
    });
    if (
      accessMode === 'plan' ||
      !options.accessMode?.options.some((option) => option.value === accessMode)
    ) {
      throw new ApplicationError(
        'INVALID_INPUT',
        'Requested access mode is unavailable for the selected provider/model'
      );
    }
  }
}

/** Coordinate the existing interactive launch policy. */
async function launchInteractiveWorkspace(
  source: InteractiveLaunchSource,
  ports: WorkspaceLaunchPorts
): Promise<{ workspace: CreatedWorkspace; defaultSessionId: string | null }> {
  const capacity = ports.getMaxSessionsPerWorkspace();
  // Explicit model validation also runs when capacity disables session provisioning.
  const provider = await preflightInteractiveLaunch(source, capacity, ports);

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
        ...explicitSessionModel(source),
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
