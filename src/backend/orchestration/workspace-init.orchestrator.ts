import { toError } from '@/backend/lib/error-utils';
import { githubCLIService } from '@/backend/services/github';
import { linearStateSyncService } from '@/backend/services/linear';
import { createLogger } from '@/backend/services/logger.service';
import {
  FactoryConfigService,
  runScriptConfigPersistenceService,
} from '@/backend/services/run-script';
import {
  buildChildWorkspaceContext,
  sessionDispatchService,
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
} from '@/backend/services/session';
import { terminalService, terminalSessionService } from '@/backend/services/terminal';
import {
  gitOpsService,
  workspaceDataService,
  workspaceRelationshipsService,
  workspaceRunScriptService,
  workspaceStateMachine,
  worktreeLifecycleService,
} from '@/backend/services/workspace';
import { type MessageAttachment, MessageState, resolveSelectedModel } from '@/shared/acp-protocol';
import { SessionStatus } from '@/shared/core';
import { isPRMonitoringRecipient } from '@/shared/pr-monitoring';
import { AttachmentSchema } from '@/shared/websocket';
import type { WorkspaceInitGuard } from '@/shared/workspace-init-retry';
import { getWorkspaceLinearContext } from './linear-config.helper';
import { bindIssueMonitoringSession } from './pr-monitoring.orchestrator';
import type { WorkspaceWithProject } from './types';
import { handleWorkspaceInitFailure, type CapturedDefaultTerminal } from './workspace-init-cleanup';
import { GitHubUsernameCache } from './workspace-init-github-username-cache';
import {
  buildInitialPromptFromGitHubIssue,
  buildInitialPromptFromLinearIssue,
} from './workspace-init-issue-prompts';
import { executeStartupScriptPipeline } from './workspace-init-script-pipeline';

const logger = createLogger('workspace-init-orchestrator');
const initialAttachmentsSchema = AttachmentSchema.array();

type CreatedWorktreeInfo = {
  worktreePath: string;
  branchName: string;
};

type WorkspaceInitializationOptions = {
  guard?: WorkspaceInitGuard;
  branchName?: string;
  useExistingBranch?: boolean;
  provisioningAlreadyStarted?: boolean;
};

interface WorkspaceDispatchDependencies {
  sessionDispatch: Pick<typeof sessionDispatchService, 'tryDispatchNextMessage'>;
}

const defaultWorkspaceDispatchDependencies: WorkspaceDispatchDependencies = {
  sessionDispatch: sessionDispatchService,
};

const gitHubUsernameCache = new GitHubUsernameCache(githubCLIService);
const workspaceInitializationTails = new Map<string, Promise<unknown>>();

function getCachedGitHubUsername(): Promise<string | null> {
  return gitHubUsernameCache.getCachedUsername();
}

export function clearWorkspaceInitOrchestratorStateForTests(): void {
  gitHubUsernameCache.clear();
  workspaceInitializationTails.clear();
}

async function startProvisioningOrLog(
  workspaceId: string,
  guard?: WorkspaceInitGuard
): Promise<boolean> {
  try {
    const started = await workspaceStateMachine.startProvisioning(
      workspaceId,
      ...(guard ? ([{ guard }] as const) : [])
    );
    if (!started) {
      logger.warn('Skipping workspace initialization: retry limit exceeded', { workspaceId });
      return false;
    }
    return true;
  } catch (error) {
    logger.error('Failed to start provisioning', toError(error), { workspaceId });
    return false;
  }
}

async function getWorkspaceWithProjectOrThrow(workspaceId: string): Promise<WorkspaceWithProject> {
  const workspaceWithProject = await workspaceDataService.findByIdWithProject(workspaceId);
  if (!workspaceWithProject?.project) {
    throw new Error('Workspace project not found');
  }
  return workspaceWithProject;
}

async function readFactoryConfigSafe(
  worktreePath: string,
  workspaceId: string
): Promise<Awaited<ReturnType<typeof FactoryConfigService.readConfig>>> {
  try {
    const factoryConfig = await FactoryConfigService.readConfig(worktreePath);
    if (factoryConfig) {
      logger.info('Found factory-factory.json config', {
        workspaceId,
        hasSetup: !!factoryConfig.scripts.setup,
        hasRun: !!factoryConfig.scripts.run,
        hasCleanup: !!factoryConfig.scripts.cleanup,
      });
    }
    return factoryConfig;
  } catch (error) {
    logger.error('Failed to parse factory-factory.json', toError(error), {
      workspaceId,
    });
    return null;
  }
}

async function markLinearIssueStartedIfApplicable(
  workspaceId: string,
  guard?: WorkspaceInitGuard
): Promise<void> {
  try {
    const ctx = await getWorkspaceLinearContext(workspaceId);
    if (!ctx) {
      return;
    }

    await guard?.check();
    guard?.assertCurrent();
    await linearStateSyncService.markIssueStarted(ctx.apiKey, ctx.linearIssueId);
    logger.info('Marked Linear issue as started', {
      workspaceId,
      linearIssueId: ctx.linearIssueId,
    });
  } catch (error) {
    logger.warn('Failed to mark Linear issue as started during workspace init', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Enqueue an auto-generated message through the session queue pipeline.
 * Used for rename instructions and initial prompts during workspace init.
 */
function enqueueAutoMessage(
  sessionId: string,
  workspaceId: string,
  text: string,
  model: string,
  attachments?: MessageAttachment[]
): void {
  const messageId = `auto-init-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
  const enqueueResult = sessionDomainService.enqueueInitialMessage(sessionId, queued);
  if (!enqueueResult) {
    return;
  }
  if ('error' in enqueueResult) {
    logger.warn('Failed to enqueue auto message for session', {
      workspaceId,
      sessionId,
      error: enqueueResult.error,
    });
  } else {
    sessionDomainService.emitDelta(sessionId, {
      type: 'message_state_changed',
      id: messageId,
      newState: MessageState.ACCEPTED,
      queuePosition: enqueueResult.position,
      userMessage: {
        text: queued.text,
        timestamp: queued.timestamp,
        attachments: queued.attachments,
        settings: {
          ...queued.settings,
          selectedModel: resolveSelectedModel(queued.settings.selectedModel),
          reasoningEffort: queued.settings.reasoningEffort,
        },
      },
    });
  }
}

interface InitialAutoMessageContent {
  text: string;
  attachments?: MessageAttachment[];
}

type WorkspaceStartupModePreset = 'non_interactive' | 'plan';

function readInitialAttachmentsFromMetadata(
  metadata: Record<string, unknown> | null,
  workspaceId: string
): MessageAttachment[] | undefined {
  if (!(metadata && 'initialAttachments' in metadata)) {
    return undefined;
  }

  const parsedAttachments = initialAttachmentsSchema.safeParse(metadata.initialAttachments);
  if (parsedAttachments.success) {
    return parsedAttachments.data;
  }

  logger.warn('Invalid initial attachments in workspace creation metadata', {
    workspaceId,
  });
  return undefined;
}

function readStartupModePresetFromMetadata(
  metadata: Record<string, unknown> | null,
  workspaceId: string
): WorkspaceStartupModePreset {
  if (!(metadata && 'startupModePreset' in metadata)) {
    return 'non_interactive';
  }

  const startupModePreset = metadata.startupModePreset;
  if (startupModePreset === 'non_interactive' || startupModePreset === 'plan') {
    return startupModePreset;
  }

  logger.warn('Invalid startup mode preset in workspace creation metadata', {
    workspaceId,
  });
  return 'non_interactive';
}

function readInitialPromptFromMetadata(
  metadata: Record<string, unknown> | null,
  workspaceId: string
): { provided: boolean; text: string } {
  if (!(metadata && Object.hasOwn(metadata, 'initialPrompt'))) {
    return { provided: false, text: '' };
  }

  if (typeof metadata.initialPrompt === 'string') {
    return { provided: true, text: metadata.initialPrompt.replaceAll('</', '<\\/') };
  }

  logger.warn('Invalid initial prompt in workspace creation metadata', {
    workspaceId,
  });
  return { provided: false, text: '' };
}

async function resolveInitialAutoMessageContent(
  workspaceId: string,
  creationMetadata: Record<string, unknown> | null
): Promise<InitialAutoMessageContent | null> {
  const metadataPrompt = readInitialPromptFromMetadata(creationMetadata, workspaceId);
  const metadataAttachments = readInitialAttachmentsFromMetadata(creationMetadata, workspaceId);

  const hasAttachments = metadataAttachments !== undefined && metadataAttachments.length > 0;
  if (metadataPrompt.provided || hasAttachments) {
    // A provided-but-blank prompt means the user cleared it: send nothing rather
    // than enqueueing an empty message the agent adapter would reject (#1689),
    // and don't fall through to rebuilding the issue prompt.
    if (!(metadataPrompt.text.trim() || hasAttachments)) {
      return null;
    }
    return {
      text: metadataPrompt.text,
      ...(hasAttachments ? { attachments: metadataAttachments } : {}),
    };
  }

  const issuePromptText =
    (await buildInitialPromptFromGitHubIssue(workspaceId, logger)) ||
    (await buildInitialPromptFromLinearIssue(workspaceId, logger));
  if (issuePromptText) {
    return { text: issuePromptText };
  }

  return null;
}

async function bindInitialMonitoringSession(workspaceId: string, sessionId: string): Promise<void> {
  try {
    await bindIssueMonitoringSession(workspaceId, sessionId);
  } catch (error) {
    logger.warn('Failed to bind initial PR monitoring conversation', {
      workspaceId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function prepareDefaultAgentSession(
  workspaceId: string,
  signal: AbortSignal,
  guard?: WorkspaceInitGuard
) {
  try {
    const sessions = await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId, {
      status: SessionStatus.IDLE,
      limit: 1,
    });
    const session = sessions[0];
    if (!session) {
      return null;
    }

    const workspace = await workspaceDataService.findById(workspaceId);
    const metadata = workspace?.creationMetadata as Record<string, unknown> | null;
    const startupModePreset = readStartupModePresetFromMetadata(metadata, workspaceId);

    // Build the initial prompt from linked issue data, or fallback to creation metadata.
    const initialMessage = await resolveInitialAutoMessageContent(workspaceId, metadata);
    const parent = workspace?.parentWorkspaceId
      ? await workspaceRelationshipsService.findParent(workspaceId)
      : null;
    const childContext = workspace?.parentWorkspaceId
      ? buildChildWorkspaceContext({
          parentWorkspaceName: parent?.name,
          parentProjectName: parent?.project.name,
          reportBackOn:
            typeof metadata?.reportBackOn === 'string' ? metadata.reportBackOn : undefined,
        })
      : undefined;
    const messageToEnqueue = childContext
      ? {
          text: `${childContext}\n${initialMessage?.text ?? ''}`.trimEnd(),
          attachments: initialMessage?.attachments,
        }
      : initialMessage;

    await guard?.check();
    guard?.assertCurrent();
    if (signal.aborted) {
      return null;
    }

    // Route the initial prompt through the queue pipeline so runtime and replay remain consistent.
    if (messageToEnqueue) {
      enqueueAutoMessage(
        session.id,
        workspaceId,
        messageToEnqueue.text,
        session.model,
        messageToEnqueue.attachments
      );
    }

    return {
      sessionId: session.id,
      startupModePreset,
      hasInitialPrompt: !!initialMessage?.text,
      hasInitialAttachments: (initialMessage?.attachments?.length ?? 0) > 0,
    };
  } catch (error) {
    logger.warn('Failed to prepare default agent session for workspace', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function startDefaultAgentSession(
  workspaceId: string,
  preparedSession: Awaited<ReturnType<typeof prepareDefaultAgentSession>>,
  dependencies: WorkspaceDispatchDependencies,
  guard?: WorkspaceInitGuard
): Promise<string | null> {
  if (!preparedSession) {
    return null;
  }
  const { sessionId, startupModePreset, hasInitialPrompt, hasInitialAttachments } = preparedSession;
  try {
    // The initial prompt is already queued; an empty string avoids the default continuation.
    await guard?.check();
    guard?.assertCurrent();
    await sessionLifecycleService.startSession(sessionId, {
      initialPrompt: '',
      startupModePreset,
      ...(guard && { assertCurrent: guard.check, assertCurrentSync: guard.assertCurrent }),
    });
    await guard?.check();
    guard?.assertCurrent();
    await bindInitialMonitoringSession(workspaceId, sessionId);

    // Trigger queue dispatch after init/session start so messages queued during
    // workspace provisioning are picked up immediately when dispatch is allowed.
    await guard?.check();
    guard?.assertCurrent();
    await dependencies.sessionDispatch.tryDispatchNextMessage(
      sessionId,
      ...(guard ? ([{ guard }] as const) : [])
    );

    logger.debug('Auto-started default Claude session for workspace', {
      workspaceId,
      sessionId,
      hasInitialPrompt,
      hasInitialAttachments,
    });
    return sessionId;
  } catch (error) {
    logger.warn('Failed to auto-start default Claude session for workspace', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function retryQueuedDispatchAfterWorkspaceReady(
  workspaceId: string,
  startedSessionId: string | null,
  dependencies: WorkspaceDispatchDependencies = defaultWorkspaceDispatchDependencies,
  guard?: WorkspaceInitGuard
): Promise<void> {
  try {
    await guard?.check();
    guard?.assertCurrent();
    // Prefer the specific session we just started; it may now be RUNNING.
    if (startedSessionId) {
      await guard?.check();
      guard?.assertCurrent();
      await bindInitialMonitoringSession(workspaceId, startedSessionId);
      await guard?.check();
      guard?.assertCurrent();
      await dependencies.sessionDispatch.tryDispatchNextMessage(
        startedSessionId,
        ...(guard ? ([{ guard }] as const) : [])
      );
      return;
    }

    const runningSessions = await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId, {
      status: SessionStatus.RUNNING,
    });
    const runningSession = runningSessions.find(isPRMonitoringRecipient);
    if (runningSession) {
      await guard?.check();
      guard?.assertCurrent();
      await bindInitialMonitoringSession(workspaceId, runningSession.id);
      await guard?.check();
      guard?.assertCurrent();
      await dependencies.sessionDispatch.tryDispatchNextMessage(
        runningSession.id,
        ...(guard ? ([{ guard }] as const) : [])
      );
      return;
    }

    const idleSessions = await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId, {
      status: SessionStatus.IDLE,
    });
    const idleSession = idleSessions.find(isPRMonitoringRecipient);
    if (!idleSession) {
      return;
    }

    await guard?.check();
    guard?.assertCurrent();
    await bindInitialMonitoringSession(workspaceId, idleSession.id);
    await guard?.check();
    guard?.assertCurrent();
    await dependencies.sessionDispatch.tryDispatchNextMessage(
      idleSession.id,
      ...(guard ? ([{ guard }] as const) : [])
    );
  } catch (error) {
    logger.warn('Failed to retry queued dispatch after workspace became ready', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function cleanupCapturedTerminal(
  workspaceId: string,
  terminalId: string,
  instance: CapturedDefaultTerminal['instance'],
  guard?: WorkspaceInitGuard
) {
  if (!guard || instance) {
    terminalService.destroyTerminal(workspaceId, terminalId, ...(instance ? [instance] : []));
  }
}

async function startDefaultTerminal(
  workspaceId: string,
  worktreePath: string,
  guard?: WorkspaceInitGuard
): Promise<
  | ({ terminalId: string; autoCreated: false } | (CapturedDefaultTerminal & { autoCreated: true }))
  | null
> {
  try {
    const existingTerminals = terminalService.getTerminalsForWorkspace(workspaceId);
    const existingTerminal = existingTerminals[0];
    if (existingTerminal) {
      return {
        terminalId: existingTerminal.id,
        autoCreated: false,
      };
    }

    await guard?.check();
    guard?.assertCurrent();
    let instance: CapturedDefaultTerminal['instance'];
    const { terminalId, pid } = await terminalService.createTerminal(
      {
        workspaceId,
        workingDir: worktreePath,
      },
      ...(guard
        ? ([
            (created: NonNullable<typeof instance>) => {
              instance = created;
            },
          ] as const)
        : [])
    );

    let unsubscribeExit: (() => void) | null = null;
    let terminalExited = false;
    let terminalSessionPersisted = false;
    const clearPersistedTerminalPid = async () => {
      try {
        await guard?.check();
        guard?.assertCurrent();
        await terminalSessionService.releaseSessionPid(
          workspaceId,
          terminalId,
          ...(guard ? ([pid] as const) : [])
        );
      } catch (error) {
        logger.warn('Failed to clear terminal PID after default terminal exit', {
          workspaceId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    unsubscribeExit = terminalService.onExit(terminalId, () => {
      terminalExited = true;
      if (!terminalSessionPersisted) {
        return;
      }

      unsubscribeExit?.();
      unsubscribeExit = null;
      void clearPersistedTerminalPid();
    });

    let registered: Awaited<ReturnType<typeof terminalSessionService.registerSession>> | undefined;
    try {
      await guard?.check();
      guard?.assertCurrent();
      registered = await terminalSessionService.registerSession(
        {
          workspaceId,
          name: terminalId,
          pid,
        },
        ...(guard ? [guard.assertCurrent] : [])
      );
      await guard?.check();
      guard?.assertCurrent();
    } catch (error) {
      unsubscribeExit?.();
      unsubscribeExit = null;
      cleanupCapturedTerminal(workspaceId, terminalId, instance, guard);
      if (guard && registered) {
        await terminalSessionService.removeCapturedSession(registered.id, pid);
      }
      throw error;
    }

    terminalSessionPersisted = true;
    if (terminalExited) {
      unsubscribeExit?.();
      unsubscribeExit = null;
      await clearPersistedTerminalPid();
    }

    logger.debug('Auto-created default terminal for workspace', {
      workspaceId,
      terminalId,
      pid,
    });

    return {
      terminalId,
      pid,
      instance,
      autoCreated: true,
    };
  } catch (error) {
    logger.warn('Failed to auto-create default terminal for workspace', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Initialize a workspace worktree: creates the git worktree, runs setup/startup
 * scripts, and starts the default Claude session.
 *
 * This is an orchestration function that coordinates across multiple domains
 * (workspace, session, github, run-script).
 */
async function createWorktreeForWorkspace(
  project: WorkspaceWithProject['project'],
  worktreeName: string,
  baseBranch: string,
  useExistingBranch: boolean,
  workspaceName: string,
  guard?: WorkspaceInitGuard
) {
  await guard?.check();
  guard?.assertCurrent();
  if (useExistingBranch) {
    return gitOpsService.createWorktreeFromExistingBranch(
      project,
      worktreeName,
      baseBranch,
      ...(guard ? ([guard] as const) : [])
    );
  }
  const gitHubUsername = await getCachedGitHubUsername();
  await guard?.check();
  guard?.assertCurrent();
  return gitOpsService.createWorktree(project, worktreeName, baseBranch, {
    ...(guard && { guard }),
    branchPrefix: gitHubUsername ?? undefined,
    workspaceName,
  });
}

export async function resolveWorkspaceWorktree(input: {
  guard?: WorkspaceInitGuard;
  workspaceWithProject: Pick<
    WorkspaceWithProject,
    'id' | 'name' | 'project' | 'worktreePath' | 'branchName'
  >;
  worktreeName: string;
  baseBranch: string;
  useExistingBranch: boolean;
}): Promise<{
  worktreePath: string;
  branchName: string | null;
  created: boolean;
}> {
  await input.guard?.check();
  input.guard?.assertCurrent();
  const workspace = input.workspaceWithProject;
  if (workspace.worktreePath) {
    logger.info('Reusing existing workspace worktree for initialization', {
      workspaceId: workspace.id,
      worktreePath: workspace.worktreePath,
    });
    return {
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName ?? null,
      created: false,
    };
  }

  await gitOpsService.ensureBaseBranchExists(
    workspace.project,
    input.baseBranch,
    workspace.project.defaultBranch
  );

  const worktreeInfo = await createWorktreeForWorkspace(
    workspace.project,
    input.worktreeName,
    input.baseBranch,
    input.useExistingBranch,
    workspace.name,
    input.guard
  );

  return {
    ...worktreeInfo,
    created: true,
  };
}

function getCreatedWorktreeCleanupCandidate(
  worktreeInfo: Awaited<ReturnType<typeof resolveWorkspaceWorktree>>,
  baseBranch: string
): CreatedWorktreeInfo | undefined {
  if (!worktreeInfo.created) {
    return undefined;
  }
  return {
    worktreePath: worktreeInfo.worktreePath,
    branchName: worktreeInfo.branchName ?? baseBranch,
  };
}

async function awaitSessionAndDispatchIfSuccess(
  workspaceId: string,
  agentSessionPromise: Promise<string | null>,
  success: boolean,
  dependencies: WorkspaceDispatchDependencies,
  guard?: WorkspaceInitGuard
) {
  const startedSessionId = await agentSessionPromise;
  if (success) {
    await retryQueuedDispatchAfterWorkspaceReady(
      workspaceId,
      startedSessionId,
      dependencies,
      guard
    );
  }
}

async function runWorkspaceInitialization(
  workspaceId: string,
  options: WorkspaceInitializationOptions | undefined,
  dependencies: WorkspaceDispatchDependencies
): Promise<void> {
  const guard = options?.guard;
  await guard?.check();
  guard?.assertCurrent();
  if (!options?.provisioningAlreadyStarted) {
    const startedProvisioning = await startProvisioningOrLog(workspaceId, guard);
    if (!startedProvisioning) {
      return;
    }
  }

  let project: WorkspaceWithProject['project'] | undefined;
  let worktreeCreated = false;
  let worktreeRegistered = false;
  let createdWorktreeInfo: CreatedWorktreeInfo | undefined;
  let autoCreatedTerminal: CapturedDefaultTerminal | undefined;
  const preparationController = new AbortController();
  let releaseInitialLaunch: (() => void) | undefined;
  let preparedSessionPromise: ReturnType<typeof prepareDefaultAgentSession> | undefined;
  let linearPromise: Promise<void> | undefined;

  try {
    const workspaceWithProject = await getWorkspaceWithProjectOrThrow(workspaceId);
    project = workspaceWithProject.project;

    // Fetch issue prompts alongside setup, publishing the queue as soon as it is ready.
    preparedSessionPromise = prepareDefaultAgentSession(
      workspaceId,
      preparationController.signal,
      guard
    );

    const worktreeName = `workspace-${workspaceId}`;
    const baseBranch = options?.branchName ?? project.defaultBranch;
    const useExistingBranch = await resolveInitMode(workspaceId, options);

    await guard?.check();
    guard?.assertCurrent();
    const worktreeInfo = await resolveWorkspaceWorktree({
      ...(guard && { guard }),
      workspaceWithProject,
      worktreeName,
      baseBranch,
      useExistingBranch,
    });
    worktreeCreated = worktreeInfo.created;
    createdWorktreeInfo = getCreatedWorktreeCleanupCandidate(worktreeInfo, baseBranch);

    const factoryConfig = await readFactoryConfigSafe(worktreeInfo.worktreePath, workspaceId);

    await guard?.check();
    guard?.assertCurrent();
    await runScriptConfigPersistenceService.syncWorkspaceCommandsFromFactoryConfig({
      workspaceId,
      factoryConfig,
      persistWorkspaceCommands: (id, commands) => {
        if (worktreeInfo.created) {
          return workspaceRunScriptService.registerInitializedWorktree(
            id,
            {
              worktreePath: worktreeInfo.worktreePath,
              branchName: worktreeInfo.branchName,
              isAutoGeneratedBranch: !useExistingBranch,
              runScriptCommand: commands.runScriptCommand,
              runScriptPostRunCommand: commands.runScriptPostRunCommand,
              runScriptCleanupCommand: commands.runScriptCleanupCommand,
            },
            ...(guard ? ([guard] as const) : [])
          );
        }

        return workspaceRunScriptService.setCommands(
          id,
          {
            runScriptCommand: commands.runScriptCommand,
            runScriptPostRunCommand: commands.runScriptPostRunCommand,
            runScriptCleanupCommand: commands.runScriptCleanupCommand,
          },
          ...(guard ? ([guard] as const) : [])
        );
      },
    });
    worktreeRegistered = true;

    const defaultTerminal = await startDefaultTerminal(
      workspaceId,
      worktreeInfo.worktreePath,
      guard
    );
    if (defaultTerminal?.autoCreated) {
      autoCreatedTerminal = defaultTerminal;
    }

    // Mark the Linear issue as started; join this non-fatal effect before draining.
    linearPromise = markLinearIssueStartedIfApplicable(workspaceId, guard);

    const startupScriptPipelineResult = await executeStartupScriptPipeline({
      workspaceId,
      workspaceWithProject,
      worktreePath: worktreeInfo.worktreePath,
      factoryConfig,
      ...(guard && { guard }),
      beforeReady: async () => {
        const prepared = await preparedSessionPromise;
        await guard?.check();
        guard?.assertCurrent();
        if (prepared) {
          releaseInitialLaunch = sessionDomainService.beginInitialLaunch(prepared.sessionId);
        }
      },
    });
    if (!startupScriptPipelineResult.handled) {
      await workspaceStateMachine.markReady(workspaceId, ...(guard ? ([{ guard }] as const) : []));
    }

    // Provider startup hooks can depend on setup's files and installed tools.
    // Finish provisioning before starting the agent's bounded startup deadline.
    const preparedSession = await preparedSessionPromise;
    const agentSessionPromise = startDefaultAgentSession(
      workspaceId,
      preparedSession ?? null,
      dependencies,
      guard
    ).catch((error) => {
      logger.error('Failed to start default Claude session', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    await awaitSessionAndDispatchIfSuccess(
      workspaceId,
      agentSessionPromise,
      startupScriptPipelineResult.success,
      dependencies,
      guard
    );
  } catch (error) {
    preparationController.abort();
    await handleWorkspaceInitFailure(
      workspaceId,
      toError(error),
      autoCreatedTerminal,
      unregisteredCandidate(project, createdWorktreeInfo, worktreeRegistered),
      guard
    );
  } finally {
    await Promise.allSettled([preparedSessionPromise, linearPromise]);
    releaseInitialLaunch?.();
    preparationController.abort();
    await clearOwnedInitMode(workspaceId, worktreeCreated, guard);
  }
}

export function enqueueWorkspaceInitializationTask<T>(
  workspaceId: string,
  task: () => Promise<T>
): Promise<T> {
  const previousInitialization = workspaceInitializationTails.get(workspaceId) ?? Promise.resolve();
  const initialization = previousInitialization.catch(() => undefined).then(task);

  workspaceInitializationTails.set(workspaceId, initialization);

  return initialization.finally(() => {
    if (workspaceInitializationTails.get(workspaceId) === initialization) {
      workspaceInitializationTails.delete(workspaceId);
    }
  });
}

export function recoverStaleProvisioningWorkspace(
  workspaceId: string,
  reason: string
): Promise<boolean> {
  // A live initializer owns the path until it settles; the next poll can re-check it.
  if (workspaceInitializationTails.has(workspaceId)) {
    return Promise.resolve(false);
  }

  return enqueueWorkspaceInitializationTask(workspaceId, async () => {
    const shouldRecover =
      await worktreeLifecycleService.prepareStaleProvisioningRecovery(workspaceId);
    if (!shouldRecover) {
      return false;
    }

    await workspaceStateMachine.markFailed(workspaceId, reason);
    return true;
  });
}

export function initializeWorkspaceWorktree(
  workspaceId: string,
  options?: WorkspaceInitializationOptions,
  dependencies: WorkspaceDispatchDependencies = defaultWorkspaceDispatchDependencies
): Promise<void> {
  return enqueueWorkspaceInitializationTask(workspaceId, () =>
    runWorkspaceInitialization(workspaceId, options, dependencies)
  );
}

async function clearOwnedInitMode(
  workspaceId: string,
  worktreeCreated: boolean,
  guard?: WorkspaceInitGuard
) {
  if (worktreeCreated) {
    try {
      await guard?.check();
      guard?.assertCurrent();
      await worktreeLifecycleService.clearInitMode(
        workspaceId,
        ...(guard ? ([guard] as const) : [])
      );
    } catch {
      /* A replacement owns its initialization state. */
    }
  }
}

async function resolveInitMode(
  workspaceId: string,
  options: WorkspaceInitializationOptions | undefined
) {
  return (
    options?.useExistingBranch ?? (await worktreeLifecycleService.getInitMode(workspaceId)) ?? false
  );
}

function unregisteredCandidate(
  project: WorkspaceWithProject['project'] | undefined,
  worktreeInfo: CreatedWorktreeInfo | undefined,
  registered: boolean
) {
  return project && worktreeInfo && !registered ? { project, worktreeInfo } : undefined;
}
