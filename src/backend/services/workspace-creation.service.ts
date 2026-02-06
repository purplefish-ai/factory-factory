import type { Prisma, Workspace } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { getDefaultWorkflowForWorkspace } from '../prompts/workflow-selection';
import { claudeSessionAccessor } from '../resource_accessors/claude-session.accessor';
import { projectAccessor } from '../resource_accessors/project.accessor';
import { userSettingsAccessor } from '../resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import type { configService } from './config.service';
import { gitOpsService } from './git-ops.service';
import type { createLogger } from './logger.service';
import { setWorkspaceInitMode } from './worktree-lifecycle.service';

type ConfigService = typeof configService;
type Logger = ReturnType<typeof createLogger>;

/**
 * Workspace creation source discriminated union.
 * Each source type has specific validation and semantic behavior.
 */
export type WorkspaceCreationSource =
  | {
      type: 'MANUAL';
      projectId: string;
      name: string;
      description?: string;
      branchName?: string;
      ratchetEnabled?: boolean;
    }
  | {
      type: 'RESUME_BRANCH';
      projectId: string;
      branchName: string;
      name?: string;
      description?: string;
      ratchetEnabled?: boolean;
    }
  | {
      type: 'GITHUB_ISSUE';
      projectId: string;
      issueNumber: number;
      issueUrl: string;
      issueLabels?: Array<{ name: string }>;
      name?: string;
      description?: string;
      ratchetEnabled?: boolean;
    };

/**
 * Result of workspace creation operation.
 */
export interface WorkspaceCreationResult {
  workspace: Workspace;
  defaultSessionCreated: boolean;
}

/**
 * Service dependencies for workspace creation.
 */
export interface WorkspaceCreationDependencies {
  logger: Logger;
  configService: ConfigService;
}

/**
 * Canonical workspace creation orchestrator.
 *
 * Responsibilities:
 * - Source-specific validation (branch checkout conflicts, etc.)
 * - Ratchet defaulting from user settings
 * - Workspace record creation with source metadata
 * - Default session provisioning policy
 * - Background worktree initialization kickoff
 *
 * All workspace creation paths (UI, issue intake, branch resume) must
 * flow through this service for consistent behavior.
 */
export class WorkspaceCreationService {
  constructor(private readonly deps: WorkspaceCreationDependencies) {}

  /**
   * Create a workspace from a source-discriminated input.
   */
  async create(source: WorkspaceCreationSource): Promise<WorkspaceCreationResult> {
    const { logger, configService } = this.deps;

    // Validate and prepare creation based on source type
    const { preparedInput, initMode } = await this.prepareCreation(source);

    // Apply ratchet default from user settings if not explicitly provided
    const ratchetEnabled = await this.resolveRatchetEnabled(source.ratchetEnabled);

    // Create workspace record
    const workspace = await workspaceAccessor.create({
      ...preparedInput,
      ratchetEnabled,
    });

    // Set initialization mode if resuming existing branch
    if (initMode) {
      await setWorkspaceInitMode(
        workspace.id,
        initMode.useExistingBranch,
        initMode.worktreeBasePath
      );
    }

    // Provision default session if enabled
    const defaultSessionCreated = await this.provisionDefaultSession(
      workspace.id,
      source,
      configService
    );

    // Kick off background initialization
    this.startBackgroundInitialization(workspace.id, source, logger);

    return {
      workspace,
      defaultSessionCreated,
    };
  }

  /**
   * Prepare workspace creation based on source type.
   * Returns normalized create input and optional init mode for branch resume.
   */
  private async prepareCreation(source: WorkspaceCreationSource): Promise<{
    preparedInput: {
      projectId: string;
      name: string;
      description?: string;
      branchName?: string;
      githubIssueNumber?: number;
      githubIssueUrl?: string;
      creationSource: 'MANUAL' | 'RESUME_BRANCH' | 'GITHUB_ISSUE';
      creationMetadata?: Prisma.InputJsonValue;
    };
    initMode?: {
      useExistingBranch: boolean;
      worktreeBasePath?: string;
    };
  }> {
    switch (source.type) {
      case 'MANUAL': {
        return {
          preparedInput: {
            projectId: source.projectId,
            name: source.name,
            description: source.description,
            branchName: source.branchName,
            creationSource: 'MANUAL',
          },
        };
      }

      case 'RESUME_BRANCH': {
        // Validate branch is not already checked out
        const project = await projectAccessor.findById(source.projectId);
        if (!project) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Project not found: ${source.projectId}`,
          });
        }

        const isCheckedOut = await gitOpsService.isBranchCheckedOut(project, source.branchName);
        if (isCheckedOut) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Branch '${source.branchName}' is already checked out in another worktree.`,
          });
        }

        return {
          preparedInput: {
            projectId: source.projectId,
            name: source.name || source.branchName,
            description: source.description,
            branchName: source.branchName,
            creationSource: 'RESUME_BRANCH',
            creationMetadata: {
              resumedBranch: source.branchName,
            },
          },
          initMode: {
            useExistingBranch: true,
            worktreeBasePath: project.worktreeBasePath,
          },
        };
      }

      case 'GITHUB_ISSUE': {
        return {
          preparedInput: {
            projectId: source.projectId,
            name: source.name || `Issue #${source.issueNumber}`,
            description: source.description,
            githubIssueNumber: source.issueNumber,
            githubIssueUrl: source.issueUrl,
            creationSource: 'GITHUB_ISSUE',
            creationMetadata: {
              issueNumber: source.issueNumber,
              issueUrl: source.issueUrl,
              issueLabels: source.issueLabels,
            },
          },
        };
      }
    }
  }

  /**
   * Resolve ratchet enabled flag with user settings default.
   */
  private async resolveRatchetEnabled(explicit?: boolean): Promise<boolean> {
    if (explicit !== undefined) {
      return explicit;
    }
    const settings = await userSettingsAccessor.get();
    return settings.ratchetEnabled;
  }

  /**
   * Provision default Claude session for workspace if max sessions > 0.
   * Returns true if session was created, false otherwise.
   */
  private async provisionDefaultSession(
    workspaceId: string,
    source: WorkspaceCreationSource,
    configService: ConfigService
  ): Promise<boolean> {
    const maxSessions = configService.getMaxSessionsPerWorkspace();
    if (maxSessions <= 0) {
      return false;
    }

    try {
      // Select appropriate workflow based on source and labels
      const workflow = getDefaultWorkflowForWorkspace(
        source.type,
        source.type === 'GITHUB_ISSUE' ? source.issueLabels : undefined
      );

      await claudeSessionAccessor.create({
        workspaceId,
        workflow,
        name: 'Chat 1',
      });
      return true;
    } catch (error) {
      this.deps.logger.warn('Failed to create default session for workspace', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Start background worktree initialization.
   * Does not await - initialization happens asynchronously and workspace
   * detail page polls for status updates.
   */
  private startBackgroundInitialization(
    workspaceId: string,
    source: WorkspaceCreationSource,
    logger: Logger
  ): void {
    // Import initializeWorkspaceWorktree dynamically to avoid circular dependency
    import('../trpc/workspace/init.trpc')
      .then(({ initializeWorkspaceWorktree }) => {
        const branchName =
          source.type === 'MANUAL'
            ? source.branchName
            : source.type === 'RESUME_BRANCH'
              ? source.branchName
              : undefined;
        const useExistingBranch = source.type === 'RESUME_BRANCH';

        return initializeWorkspaceWorktree(workspaceId, {
          branchName,
          useExistingBranch,
        });
      })
      .catch((error) => {
        logger.error(
          'Unexpected error during background workspace initialization',
          error as Error,
          {
            workspaceId,
          }
        );
      });
  }
}
