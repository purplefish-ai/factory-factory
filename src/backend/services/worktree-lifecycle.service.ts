import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TRPCError } from '@trpc/server';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { FactoryConfigService } from './factory-config.service';
import { gitOpsService } from './git-ops.service';
import { githubCLIService } from './github-cli.service';
import { createLogger } from './logger.service';
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

function pathExists(targetPath: string): Promise<boolean> {
  return fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false);
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
  }

  return true;
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

    // Close associated GitHub issue if one exists
    const project = workspace.project;
    if (workspace.githubIssueNumber && project?.githubOwner && project?.githubRepo) {
      try {
        await githubCLIService.closeIssue(
          project.githubOwner,
          project.githubRepo,
          workspace.githubIssueNumber
        );
        logger.info('Closed GitHub issue on workspace archive', {
          workspaceId: workspace.id,
          issueNumber: workspace.githubIssueNumber,
        });
      } catch (error) {
        // Log but don't fail the archive if issue closing fails
        logger.warn('Failed to close GitHub issue on workspace archive', {
          workspaceId: workspace.id,
          issueNumber: workspace.githubIssueNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return workspaceStateMachine.archive(workspace.id);
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
        runScriptCommand: factoryConfig?.scripts.run ?? null,
        runScriptCleanupCommand: factoryConfig?.scripts.cleanup ?? null,
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
      logger.error('Failed to initialize workspace worktree', error as Error, {
        workspaceId,
      });
      await workspaceStateMachine.markFailed(workspaceId, (error as Error).message);
    } finally {
      if (worktreeCreated) {
        await clearWorkspaceInitMode(workspaceId, project?.worktreeBasePath);
      }
    }
  }
}

export const worktreeLifecycleService = new WorktreeLifecycleService();
