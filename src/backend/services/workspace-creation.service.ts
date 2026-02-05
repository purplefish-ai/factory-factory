import type { Workspace } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { DEFAULT_FIRST_SESSION } from '../prompts/workflows';
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
      /** Preserved from legacy input for backward compatibility */
      githubIssueNumber?: number;
      /** Preserved from legacy input for backward compatibility */
      githubIssueUrl?: string;
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
      name?: string;
      description?: string;
      ratchetEnabled?: boolean;
    };

/**
 * Compatibility adapter for old workspace create input format.
 * Supports migration from existing tRPC procedure input shape.
 */
export interface LegacyCreateWorkspaceInput {
  projectId: string;
  name: string;
  description?: string;
  branchName?: string;
  useExistingBranch?: boolean;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  ratchetEnabled?: boolean;
}

/**
 * Converts legacy input format to source-discriminated format.
 */
export function adaptLegacyCreateInput(input: LegacyCreateWorkspaceInput): WorkspaceCreationSource {
  // Resume branch takes precedence
  if (input.useExistingBranch && input.branchName) {
    return {
      type: 'RESUME_BRANCH',
      projectId: input.projectId,
      branchName: input.branchName,
      name: input.name,
      description: input.description,
      ratchetEnabled: input.ratchetEnabled,
    };
  }

  // GitHub issue creation
  if (input.githubIssueNumber !== undefined && input.githubIssueUrl) {
    return {
      type: 'GITHUB_ISSUE',
      projectId: input.projectId,
      issueNumber: input.githubIssueNumber,
      issueUrl: input.githubIssueUrl,
      name: input.name,
      description: input.description,
      ratchetEnabled: input.ratchetEnabled,
    };
  }

  // Default to manual creation, preserving any partial GitHub issue data
  // to maintain backward compatibility with old code that passed all fields through.
  return {
    type: 'MANUAL',
    projectId: input.projectId,
    name: input.name,
    description: input.description,
    branchName: input.branchName,
    ratchetEnabled: input.ratchetEnabled,
    githubIssueNumber: input.githubIssueNumber,
    githubIssueUrl: input.githubIssueUrl,
  };
}

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
    const defaultSessionCreated = await this.provisionDefaultSession(workspace.id, configService);

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
            githubIssueNumber: source.githubIssueNumber,
            githubIssueUrl: source.githubIssueUrl,
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
    configService: ConfigService
  ): Promise<boolean> {
    const maxSessions = configService.getMaxSessionsPerWorkspace();
    if (maxSessions <= 0) {
      return false;
    }

    try {
      await claudeSessionAccessor.create({
        workspaceId,
        workflow: DEFAULT_FIRST_SESSION,
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
