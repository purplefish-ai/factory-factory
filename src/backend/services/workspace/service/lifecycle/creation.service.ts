import type { Prisma, SessionProvider, Workspace } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import type { AutoIterationConfig } from '@/backend/services/auto-iteration';
import { gitOpsService } from '@/backend/services/git-ops.service';
import type { createLogger } from '@/backend/services/logger.service';
import { userSettingsAccessor } from '@/backend/services/settings';
import { projectAccessor } from '@/backend/services/workspace/resources/project.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { worktreeLifecycleService } from '@/backend/services/workspace/service/worktree/worktree-lifecycle.service';
import type { MessageAttachment } from '@/shared/acp-protocol';

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
      initialPrompt?: string;
      initialAttachments?: MessageAttachment[];
      startupModePreset?: 'non_interactive' | 'plan';
      provider?: SessionProvider;
      mode?: 'STANDARD' | 'AUTO_ITERATION';
      autoIterationConfig?: AutoIterationConfig;
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
      startupModePreset?: 'non_interactive' | 'plan';
    }
  | {
      type: 'LINEAR_ISSUE';
      projectId: string;
      issueId: string;
      issueIdentifier: string;
      issueUrl: string;
      name?: string;
      description?: string;
      ratchetEnabled?: boolean;
      startupModePreset?: 'non_interactive' | 'plan';
    };

/**
 * Service dependencies for workspace creation.
 */
export interface WorkspaceCreationDependencies {
  logger: Logger;
}

type PreparedWorkspaceCreation = {
  preparedInput: {
    projectId: string;
    name: string;
    description?: string;
    branchName?: string;
    githubIssueNumber?: number;
    githubIssueUrl?: string;
    linearIssueId?: string;
    linearIssueIdentifier?: string;
    linearIssueUrl?: string;
    creationSource: 'MANUAL' | 'RESUME_BRANCH' | 'GITHUB_ISSUE' | 'LINEAR_ISSUE';
    creationMetadata?: Prisma.InputJsonValue;
    mode?: 'STANDARD' | 'AUTO_ITERATION';
    autoIterationConfig?: Prisma.InputJsonValue;
  };
  initMode?: {
    useExistingBranch: boolean;
  };
};

/**
 * Canonical workspace creation orchestrator.
 *
 * Responsibilities:
 * - Source-specific validation (branch checkout conflicts, etc.)
 * - Ratchet defaulting from user settings
 * - Workspace record creation with source metadata
 * All workspace creation paths (UI, issue intake, branch resume) must
 * flow through this service for consistent behavior.
 */
export class WorkspaceCreationService {
  constructor(private readonly deps: WorkspaceCreationDependencies) {}

  /**
   * Create a workspace from a source-discriminated input.
   */
  async create(source: WorkspaceCreationSource): Promise<Workspace> {
    this.deps.logger.debug('Creating workspace from source', { sourceType: source.type });

    // Validate and prepare creation based on source type
    const { preparedInput, initMode } = await this.prepareCreation(source);

    // Apply workspace creation defaults from user settings where needed.
    const ratchetEnabled = await this.resolveWorkspaceCreationDefaults(source.ratchetEnabled);

    // Create workspace record
    const workspace = await workspaceAccessor.create({
      ...preparedInput,
      ratchetEnabled,
    });

    // Set initialization mode if resuming existing branch
    if (initMode) {
      await worktreeLifecycleService.setInitMode(workspace.id, initMode.useExistingBranch);
    }

    return workspace;
  }

  /**
   * Prepare workspace creation based on source type.
   * Returns normalized create input and optional init mode for branch resume.
   */
  private async prepareCreation(
    source: WorkspaceCreationSource
  ): Promise<PreparedWorkspaceCreation> {
    switch (source.type) {
      case 'MANUAL':
        return this.prepareManualCreation(source);
      case 'RESUME_BRANCH':
        return await this.prepareResumeBranchCreation(source);
      case 'GITHUB_ISSUE':
        return this.prepareGitHubIssueCreation(source);
      case 'LINEAR_ISSUE':
        return this.prepareLinearIssueCreation(source);
    }
  }

  private prepareManualCreation(
    source: Extract<WorkspaceCreationSource, { type: 'MANUAL' }>
  ): PreparedWorkspaceCreation {
    if (source.mode === 'AUTO_ITERATION' && !source.autoIterationConfig) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'autoIterationConfig is required for AUTO_ITERATION workspaces',
      });
    }
    if (source.autoIterationConfig && source.mode !== 'AUTO_ITERATION') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'autoIterationConfig is only allowed for AUTO_ITERATION workspaces',
      });
    }

    const metadata: Record<string, unknown> = {};
    if (source.initialPrompt) {
      metadata.initialPrompt = source.initialPrompt;
    }
    if (source.initialAttachments && source.initialAttachments.length > 0) {
      metadata.initialAttachments = source.initialAttachments;
    }
    if (source.startupModePreset) {
      metadata.startupModePreset = source.startupModePreset;
    }

    return {
      preparedInput: {
        projectId: source.projectId,
        name: source.name,
        description: source.description,
        branchName: source.branchName,
        creationSource: 'MANUAL',
        ...(Object.keys(metadata).length > 0
          ? { creationMetadata: metadata as Prisma.InputJsonValue }
          : {}),
        ...(source.mode ? { mode: source.mode } : {}),
        ...(source.autoIterationConfig
          ? { autoIterationConfig: source.autoIterationConfig as unknown as Prisma.InputJsonValue }
          : {}),
      },
    };
  }

  private async prepareResumeBranchCreation(
    source: Extract<WorkspaceCreationSource, { type: 'RESUME_BRANCH' }>
  ): Promise<PreparedWorkspaceCreation> {
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
      },
    };
  }

  private prepareGitHubIssueCreation(
    source: Extract<WorkspaceCreationSource, { type: 'GITHUB_ISSUE' }>
  ): PreparedWorkspaceCreation {
    const metadata: Record<string, unknown> = {
      issueNumber: source.issueNumber,
      issueUrl: source.issueUrl,
    };
    if (source.startupModePreset) {
      metadata.startupModePreset = source.startupModePreset;
    }

    return {
      preparedInput: {
        projectId: source.projectId,
        name: source.name || `Issue #${source.issueNumber}`,
        description: source.description,
        githubIssueNumber: source.issueNumber,
        githubIssueUrl: source.issueUrl,
        creationSource: 'GITHUB_ISSUE',
        creationMetadata: metadata as Prisma.InputJsonValue,
      },
    };
  }

  private prepareLinearIssueCreation(
    source: Extract<WorkspaceCreationSource, { type: 'LINEAR_ISSUE' }>
  ): PreparedWorkspaceCreation {
    const metadata: Record<string, unknown> = {
      issueId: source.issueId,
      issueIdentifier: source.issueIdentifier,
      issueUrl: source.issueUrl,
    };
    if (source.startupModePreset) {
      metadata.startupModePreset = source.startupModePreset;
    }

    return {
      preparedInput: {
        projectId: source.projectId,
        name: source.name || source.issueIdentifier,
        description: source.description,
        linearIssueId: source.issueId,
        linearIssueIdentifier: source.issueIdentifier,
        linearIssueUrl: source.issueUrl,
        creationSource: 'LINEAR_ISSUE',
        creationMetadata: metadata as Prisma.InputJsonValue,
      },
    };
  }

  private async resolveWorkspaceCreationDefaults(
    explicitRatchetEnabled?: boolean
  ): Promise<boolean> {
    const settings = await userSettingsAccessor.get();
    return explicitRatchetEnabled ?? settings.ratchetEnabled;
  }
}
