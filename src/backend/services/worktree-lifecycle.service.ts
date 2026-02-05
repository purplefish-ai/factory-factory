import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SessionStatus } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { pathExists } from '../lib/file-helpers';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { FactoryConfigService } from './factory-config.service';
import { gitOpsService } from './git-ops.service';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';
import { messageStateService } from './message-state.service';
import { RunScriptService } from './run-script.service';
import { sessionService } from './session.service';
import { startupScriptService } from './startup-script.service';
import { terminalService } from './terminal.service';
import { workspaceStateMachine } from './workspace-state-machine.service';

const logger = createLogger('worktree-lifecycle');
const workspaceInitModes = new Map<string, boolean>();
const RESUME_MODE_FILENAME = '.ff-resume-modes.json';
const resumeModeLocks = new Map<string, Promise<void>>();

async function withResumeModeLock<T>(
  worktreeBasePath: string,
  handler: () => Promise<T>
): Promise<T> {
  const previous = resumeModeLocks.get(worktreeBasePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = previous.then(() => next);
  resumeModeLocks.set(worktreeBasePath, lock);
  await previous;
  try {
    return await handler();
  } finally {
    release?.();
    if (resumeModeLocks.get(worktreeBasePath) === lock) {
      resumeModeLocks.delete(worktreeBasePath);
    }
  }
}

async function readResumeModes(worktreeBasePath: string): Promise<Record<string, boolean>> {
  const filePath = path.join(worktreeBasePath, RESUME_MODE_FILENAME);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    try {
      return JSON.parse(content) as Record<string, boolean>;
    } catch (error) {
      logger.warn('Failed to parse resume modes file; falling back to empty', {
        filePath,
        worktreeBasePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && code !== 'ENOENT') {
      logger.warn('Failed to read resume modes file; falling back to empty', {
        filePath,
        worktreeBasePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {};
  }
}

async function writeResumeModes(
  worktreeBasePath: string,
  modes: Record<string, boolean>
): Promise<void> {
  await fs.mkdir(worktreeBasePath, { recursive: true });
  await fs.writeFile(
    path.join(worktreeBasePath, RESUME_MODE_FILENAME),
    JSON.stringify(modes),
    'utf-8'
  );
}

async function updateResumeModes(
  worktreeBasePath: string,
  handler: (modes: Record<string, boolean>) => void
): Promise<void> {
  await withResumeModeLock(worktreeBasePath, async () => {
    const modes = await readResumeModes(worktreeBasePath);
    handler(modes);
    await writeResumeModes(worktreeBasePath, modes);
  });
}

export async function setWorkspaceInitMode(
  workspaceId: string,
  useExistingBranch: boolean | undefined,
  worktreeBasePath?: string
): Promise<void> {
  if (useExistingBranch === undefined) {
    return;
  }
  workspaceInitModes.set(workspaceId, useExistingBranch);
  if (worktreeBasePath) {
    await updateResumeModes(worktreeBasePath, (modes) => {
      modes[workspaceId] = useExistingBranch;
    });
  }
}

export async function getWorkspaceInitMode(
  workspaceId: string,
  worktreeBasePath?: string
): Promise<boolean | undefined> {
  if (workspaceInitModes.has(workspaceId)) {
    return workspaceInitModes.get(workspaceId);
  }
  if (!worktreeBasePath) {
    return undefined;
  }
  const modes = await readResumeModes(worktreeBasePath);
  return modes[workspaceId];
}

async function clearWorkspaceInitMode(
  workspaceId: string,
  worktreeBasePath?: string
): Promise<void> {
  workspaceInitModes.delete(workspaceId);
  if (!worktreeBasePath) {
    return;
  }
  await updateResumeModes(worktreeBasePath, (modes) => {
    if (workspaceId in modes) {
      delete modes[workspaceId];
    }
  });
}

// Cache the authenticated GitHub username (fetched once per server lifetime)
let cachedGitHubUsername: string | null | undefined;

type WorkspaceWithProject = Exclude<
  Awaited<ReturnType<typeof workspaceAccessor.findByIdWithProject>>,
  null | undefined
>;

interface WorktreeCleanupOptions {
  commitUncommitted: boolean;
}

export class WorktreePathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreePathSafetyError';
  }
}

export function assertWorktreePathSafe(worktreePath: string, worktreeBasePath: string): void {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedBasePath = path.resolve(worktreeBasePath);
  const basePrefix = `${resolvedBasePath}${path.sep}`;

  if (resolvedWorktreePath === resolvedBasePath || !resolvedWorktreePath.startsWith(basePrefix)) {
    throw new WorktreePathSafetyError(
      'Workspace worktree path is outside the worktree base directory'
    );
  }
}

function getProjectOrThrow(workspace: WorkspaceWithProject) {
  const project = workspace.project;
  if (!(project?.repoPath && project.worktreeBasePath)) {
    throw new Error('Workspace project paths are missing');
  }
  return project;
}

async function startProvisioningOrLog(workspaceId: string): Promise<boolean> {
  try {
    await workspaceStateMachine.startProvisioning(workspaceId);
    return true;
  } catch (error) {
    logger.error('Failed to start provisioning', error as Error, { workspaceId });
    return false;
  }
}

async function getWorkspaceWithProjectOrThrow(workspaceId: string): Promise<WorkspaceWithProject> {
  const workspaceWithProject = await workspaceAccessor.findByIdWithProject(workspaceId);
  if (!workspaceWithProject?.project) {
    throw new Error('Workspace project not found');
  }
  return workspaceWithProject;
}

async function getCachedGitHubUsername(): Promise<string | null> {
  if (cachedGitHubUsername === undefined) {
    cachedGitHubUsername = await githubCLIService.getAuthenticatedUsername();
  }
  return cachedGitHubUsername ?? null;
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
    logger.error('Failed to parse factory-factory.json', error as Error, {
      workspaceId,
    });
    return null;
  }
}

async function runFactorySetupScriptIfConfigured(
  workspaceId: string,
  workspaceWithProject: WorkspaceWithProject,
  worktreePath: string,
  factoryConfig: Awaited<ReturnType<typeof FactoryConfigService.readConfig>>
): Promise<boolean> {
  if (!factoryConfig?.scripts.setup) {
    return false;
  }

  logger.info('Running setup script from factory-factory.json', { workspaceId });

  const scriptResult = await startupScriptService.runStartupScript(
    { ...workspaceWithProject, worktreePath },
    {
      ...workspaceWithProject.project,
      startupScriptCommand: factoryConfig.scripts.setup,
      startupScriptPath: null,
    }
  );

  if (!scriptResult.success) {
    const finalWorkspace = await workspaceAccessor.findById(workspaceId);
    logger.warn('Setup script from factory-factory.json failed but workspace created', {
      workspaceId,
      error: finalWorkspace?.initErrorMessage,
    });
    try {
      await sessionService.stopWorkspaceSessions(workspaceId);
    } catch (error) {
      logger.warn('Failed to stop Claude sessions after setup script failure', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return true;
}

async function runProjectStartupScriptIfConfigured(
  workspaceId: string,
  workspaceWithProject: WorkspaceWithProject,
  worktreePath: string
): Promise<boolean> {
  const project = workspaceWithProject.project;
  if (!startupScriptService.hasStartupScript(project)) {
    return false;
  }

  logger.info('Running startup script for workspace', {
    workspaceId,
    hasCommand: !!project.startupScriptCommand,
    hasScriptPath: !!project.startupScriptPath,
  });

  const scriptResult = await startupScriptService.runStartupScript(
    { ...workspaceWithProject, worktreePath },
    project
  );

  if (!scriptResult.success) {
    const finalWorkspace = await workspaceAccessor.findById(workspaceId);
    logger.warn('Startup script failed but workspace created', {
      workspaceId,
      error: finalWorkspace?.initErrorMessage,
    });
    try {
      await sessionService.stopWorkspaceSessions(workspaceId);
    } catch (error) {
      logger.warn('Failed to stop Claude sessions after startup script failure', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return true;
}

async function handleWorkspaceInitFailure(workspaceId: string, error: Error): Promise<void> {
  logger.error('Failed to initialize workspace worktree', error, { workspaceId });
  await workspaceStateMachine.markFailed(workspaceId, error.message);
  try {
    await sessionService.stopWorkspaceSessions(workspaceId);
  } catch (stopError) {
    logger.warn('Failed to stop Claude sessions after init failure', {
      workspaceId,
      error: stopError instanceof Error ? stopError.message : String(stopError),
    });
  }
}

async function buildInitialPromptFromGitHubIssue(workspaceId: string): Promise<string> {
  try {
    const workspace = await workspaceAccessor.findByIdWithProject(workspaceId);
    if (!workspace?.githubIssueNumber) {
      return '';
    }

    const project = workspace.project;
    if (!(project?.githubOwner && project?.githubRepo)) {
      return '';
    }

    const issue = await githubCLIService.getIssue(
      project.githubOwner,
      project.githubRepo,
      workspace.githubIssueNumber
    );

    if (!issue) {
      logger.warn('Failed to fetch GitHub issue for initial prompt', {
        workspaceId,
        issueNumber: workspace.githubIssueNumber,
      });
      return '';
    }

    logger.info('Built initial prompt from GitHub issue', {
      workspaceId,
      issueNumber: issue.number,
      issueTitle: issue.title,
    });

    return `Please work on the following GitHub issue and take it through the full development pipeline:

## Issue #${issue.number}: ${issue.title}

${issue.body || '(No description provided)'}

---

GitHub Issue URL: ${issue.url}

## Instructions

Please complete the following steps:

1. **Plan**: Analyze the issue and come up with a plan to implement it. Consider the codebase structure, existing patterns, and any edge cases.

2. **Implement**: If the requirements are clear and no clarification is needed, proceed to implement the plan. Write clean, well-tested code that follows the project's conventions.

3. **Review**: After implementation, review your own code for:
   - Correctness and completeness
   - Code quality and adherence to project patterns
   - Potential bugs or edge cases
   - Test coverage

4. **Create PR**: Once you're satisfied with the implementation, create a pull request with:
   - A clear title and description
   - Reference to this issue
   - Summary of changes made

If you need clarification on any requirements before proceeding, ask for clarification first.`;
  } catch (error) {
    logger.warn('Error building initial prompt from GitHub issue', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

async function startDefaultClaudeSession(workspaceId: string): Promise<void> {
  try {
    const sessions = await claudeSessionAccessor.findByWorkspaceId(workspaceId, {
      status: SessionStatus.IDLE,
      limit: 1,
    });
    const session = sessions[0];
    if (!session) {
      return;
    }

    // Build the initial prompt - use GitHub issue content if available
    const issuePrompt = await buildInitialPromptFromGitHubIssue(workspaceId);

    // If we have a GitHub issue prompt, inject it into the message state
    // so it appears in the chat UI as a user message
    if (issuePrompt) {
      messageStateService.injectCommittedUserMessage(session.id, issuePrompt);
    }

    // Start the session - pass empty string to start without any initial prompt
    // (undefined would default to 'Continue with the task.')
    await sessionService.startClaudeSession(session.id, { initialPrompt: '' });

    // If we have a GitHub issue prompt, send it via sendMessage so it goes through
    // the normal event pipeline and responses are properly captured
    if (issuePrompt) {
      const client = sessionService.getClient(session.id);
      if (client) {
        try {
          await client.sendMessage(issuePrompt);
        } catch (error) {
          logger.warn('Failed to send GitHub issue prompt to session', {
            workspaceId,
            sessionId: session.id,
            error,
          });
        }
        logger.info('Sent GitHub issue prompt to session via sendMessage', {
          workspaceId,
          sessionId: session.id,
        });
      } else {
        logger.warn('Could not get client to send GitHub issue prompt', {
          workspaceId,
          sessionId: session.id,
        });
      }
    }

    logger.debug('Auto-started default Claude session for workspace', {
      workspaceId,
      sessionId: session.id,
      hasGitHubIssuePrompt: !!issuePrompt,
    });
  } catch (error) {
    logger.warn('Failed to auto-start default Claude session for workspace', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

class WorktreeLifecycleService {
  async cleanupWorkspaceWorktree(
    workspace: WorkspaceWithProject,
    options: WorktreeCleanupOptions
  ): Promise<void> {
    const worktreePath = workspace.worktreePath;
    if (!worktreePath) {
      return;
    }

    const project = getProjectOrThrow(workspace);
    assertWorktreePathSafe(worktreePath, project.worktreeBasePath);

    const worktreeExists = await pathExists(worktreePath);
    if (!worktreeExists) {
      return;
    }

    await gitOpsService.commitIfNeeded(worktreePath, workspace.name, options.commitUncommitted);
    await gitOpsService.removeWorktree(worktreePath, project);
  }

  /**
   * Handle GitHub issue after workspace archive.
   * If there's a merged PR, add a comment referencing it.
   */
  private async handleGitHubIssueOnArchive(workspace: WorkspaceWithProject): Promise<void> {
    const project = workspace.project;
    if (!(workspace.githubIssueNumber && project?.githubOwner && project?.githubRepo)) {
      return;
    }

    // Only add a comment if there's a merged PR
    if (!(workspace.prState === 'MERGED' && workspace.prUrl)) {
      return;
    }

    try {
      const comment = `This workspace has been archived. The associated PR was merged: ${workspace.prUrl}`;
      await githubCLIService.addIssueComment(
        project.githubOwner,
        project.githubRepo,
        workspace.githubIssueNumber,
        comment
      );
      logger.info('Added comment to GitHub issue on workspace archive', {
        workspaceId: workspace.id,
        issueNumber: workspace.githubIssueNumber,
        prUrl: workspace.prUrl,
      });
    } catch (error) {
      // Log but don't fail the archive if comment fails
      logger.warn('Failed to add comment to GitHub issue on workspace archive', {
        workspaceId: workspace.id,
        issueNumber: workspace.githubIssueNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async archiveWorkspace(workspace: WorkspaceWithProject, options: WorktreeCleanupOptions) {
    if (!workspaceStateMachine.isValidTransition(workspace.status, 'ARCHIVED')) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Cannot archive workspace from status: ${workspace.status}`,
      });
    }

    try {
      await sessionService.stopWorkspaceSessions(workspace.id);
      await RunScriptService.stopRunScript(workspace.id);
      terminalService.destroyWorkspaceTerminals(workspace.id);
    } catch (error) {
      logger.error('Failed to cleanup workspace resources before archive', {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.cleanupWorkspaceWorktree(workspace, options);
    } catch (error) {
      logger.error('Failed to cleanup workspace worktree before archive', {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const archivedWorkspace = await workspaceStateMachine.archive(workspace.id);

    // Handle associated GitHub issue after successful archive
    await this.handleGitHubIssueOnArchive(workspace);

    return archivedWorkspace;
  }

  async initializeWorkspaceWorktree(
    workspaceId: string,
    options?: { branchName?: string; useExistingBranch?: boolean }
  ): Promise<void> {
    const startedProvisioning = await startProvisioningOrLog(workspaceId);
    if (!startedProvisioning) {
      return;
    }

    let project: WorkspaceWithProject['project'] | undefined;
    let worktreeCreated = false;

    try {
      const workspaceWithProject = await getWorkspaceWithProjectOrThrow(workspaceId);
      project = workspaceWithProject.project;

      const worktreeName = `workspace-${workspaceId}`;
      const baseBranch = options?.branchName ?? project.defaultBranch;
      const useExistingBranch =
        options?.useExistingBranch ??
        (await getWorkspaceInitMode(workspaceId, project.worktreeBasePath)) ??
        false;

      await gitOpsService.ensureBaseBranchExists(project, baseBranch, project.defaultBranch);

      const worktreeInfo = useExistingBranch
        ? await gitOpsService.createWorktreeFromExistingBranch(project, worktreeName, baseBranch)
        : await (async () => {
            const gitHubUsername = await getCachedGitHubUsername();
            return gitOpsService.createWorktree(project, worktreeName, baseBranch, {
              branchPrefix: gitHubUsername ?? undefined,
              workspaceName: workspaceWithProject.name,
            });
          })();
      worktreeCreated = true;

      const factoryConfig = await readFactoryConfigSafe(worktreeInfo.worktreePath, workspaceId);

      await workspaceAccessor.update(workspaceId, {
        worktreePath: worktreeInfo.worktreePath,
        branchName: worktreeInfo.branchName,
        // Mark branch as auto-generated when we created a new branch (not using existing)
        isAutoGeneratedBranch: !useExistingBranch,
        hasFactoryConfig: factoryConfig !== null,
        runScriptCommand: factoryConfig?.scripts.run ?? null,
        runScriptCleanupCommand: factoryConfig?.scripts.cleanup ?? null,
      });

      void startDefaultClaudeSession(workspaceId).catch((error) => {
        logger.error('Failed to start default Claude session', {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      const ranFactorySetup = await runFactorySetupScriptIfConfigured(
        workspaceId,
        workspaceWithProject,
        worktreeInfo.worktreePath,
        factoryConfig
      );
      if (ranFactorySetup) {
        return;
      }

      const ranProjectSetup = await runProjectStartupScriptIfConfigured(
        workspaceId,
        workspaceWithProject,
        worktreeInfo.worktreePath
      );
      if (ranProjectSetup) {
        return;
      }

      await workspaceStateMachine.markReady(workspaceId);
    } catch (error) {
      await handleWorkspaceInitFailure(workspaceId, error as Error);
    } finally {
      if (worktreeCreated) {
        await clearWorkspaceInitMode(workspaceId, project?.worktreeBasePath);
      }
    }
  }
}

export const worktreeLifecycleService = new WorktreeLifecycleService();
