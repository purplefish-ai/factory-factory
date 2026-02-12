import type { Prisma, Workspace } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { worktreeLifecycleService } from '@/backend/domains/workspace/worktree/worktree-lifecycle.service';
import { getClaudeProjectPath } from '@/backend/lib/claude-paths';
import { DEFAULT_FOLLOWUP } from '@/backend/prompts/workflows';
import { claudeSessionAccessor } from '@/backend/resource_accessors/claude-session.accessor';
import { projectAccessor } from '@/backend/resource_accessors/project.accessor';
import { userSettingsAccessor } from '@/backend/resource_accessors/user-settings.accessor';
import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import type { configService } from '@/backend/services/config.service';
import { gitOpsService } from '@/backend/services/git-ops.service';
import type { createLogger } from '@/backend/services/logger.service';

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
    const { configService } = this.deps;

    // Validate and prepare creation based on source type
    const { preparedInput, initMode } = await this.prepareCreation(source);

    // Apply ratchet default from user settings if not explicitly provided
    const ratchetEnabled = await this.resolveRatchetEnabled(source.ratchetEnabled);
    const defaultSessionProvider = await this.resolveDefaultSessionProvider();

    // Create workspace record
    const workspace = await workspaceAccessor.create({
      ...preparedInput,
      ratchetEnabled,
    });

    // Set initialization mode if resuming existing branch
    if (initMode) {
      await worktreeLifecycleService.setInitMode(
        workspace.id,
        initMode.useExistingBranch,
        initMode.worktreeBasePath
      );
    }

    // Provision default session if enabled
    const defaultSessionCreated = await this.provisionDefaultSession(
      workspace.id,
      configService,
      defaultSessionProvider
    );

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

  private resolveDefaultSessionProvider(): Promise<'CLAUDE' | 'CODEX'> {
    return userSettingsAccessor.getDefaultSessionProvider();
  }

  /**
   * Provision default Claude session for workspace if max sessions > 0.
   * Returns true if session was created, false otherwise.
   */
  private async provisionDefaultSession(
    workspaceId: string,
    configService: ConfigService,
    provider: 'CLAUDE' | 'CODEX'
  ): Promise<boolean> {
    const maxSessions = configService.getMaxSessionsPerWorkspace();
    if (maxSessions <= 0) {
      return false;
    }

    try {
      const workspace = await workspaceAccessor.findById(workspaceId);
      const claudeProjectPath =
        provider === 'CLAUDE' && workspace?.worktreePath
          ? getClaudeProjectPath(workspace.worktreePath)
          : null;
      await claudeSessionAccessor.create({
        workspaceId,
        workflow: DEFAULT_FOLLOWUP,
        name: 'Chat 1',
        provider,
        claudeProjectPath,
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
}
