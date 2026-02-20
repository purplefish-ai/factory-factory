/**
 * Pre-PR Branch Rename Interceptor
 *
 * Detects `gh pr create` on tool start and renames auto-generated branches
 * to meaningful names before the PR is created. Uses direct `git branch -m`
 * so the rename completes before the network-bound `gh pr create` executes.
 */

import { projectManagementService, workspaceDataService } from '@/backend/domains/workspace';
import { gitCommand } from '@/backend/lib/shell';
import { extractInputValue, isString } from '@/backend/schemas/tool-inputs.schema';
import { createLogger } from '@/backend/services/logger.service';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('pre-pr-rename');
const GH_PR_CREATE_REGEX = /\bgh\s+pr\s+create\b/;

// Track workspaces that have already been renamed to avoid duplicate renames
const renamedWorkspaces = new Set<string>();
const remoteCleanupCandidates = new Map<
  string,
  { oldBranchName: string; newBranchName: string; workspaceId: string; workingDir: string }
>();

/**
 * Generate a branch name from workspace context.
 *
 * Kebab-cases the workspace name and optionally prepends a prefix.
 * Result is capped at 60 characters (prefix + slash + name).
 */
export function generateBranchName(context: {
  branchPrefix: string;
  workspaceName: string;
}): string {
  const slug = context.workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

  if (!slug) {
    return '';
  }

  if (context.branchPrefix) {
    return `${context.branchPrefix}/${slug}`;
  }
  return slug;
}

function extractCommand(event: ToolEvent): string | undefined {
  const command = extractInputValue(event.input, 'command', isString, event.toolName, logger);
  if (command && GH_PR_CREATE_REGEX.test(command)) {
    return command;
  }

  const cmd = extractInputValue(event.input, 'cmd', isString, event.toolName, logger);
  if (cmd && GH_PR_CREATE_REGEX.test(cmd)) {
    return cmd;
  }

  const title = extractInputValue(event.input, 'title', isString, event.toolName, logger);
  if (title && GH_PR_CREATE_REGEX.test(title)) {
    return title;
  }

  if (GH_PR_CREATE_REGEX.test(event.toolName)) {
    return event.toolName;
  }

  return undefined;
}

function parseRemoteName(upstreamRef: string): string | undefined {
  const slashIndex = upstreamRef.indexOf('/');
  if (slashIndex <= 0) {
    return undefined;
  }
  return upstreamRef.slice(0, slashIndex);
}

async function getRefCommit(ref: string, workingDir: string): Promise<string | undefined> {
  const result = await gitCommand(['rev-parse', '--verify', '--quiet', ref], workingDir);
  if (result.code !== 0) {
    return undefined;
  }
  const commit = result.stdout.trim();
  return commit || undefined;
}

async function cleanupSupersededRemoteBranch(context: {
  workspaceId: string;
  workingDir: string;
  oldBranchName: string;
  newBranchName: string;
}): Promise<void> {
  if (context.oldBranchName === context.newBranchName) {
    return;
  }

  const headResult = await gitCommand(['rev-parse', 'HEAD'], context.workingDir);
  if (headResult.code !== 0) {
    logger.warn('Skipping remote branch cleanup; failed to resolve HEAD', {
      workspaceId: context.workspaceId,
      stderr: headResult.stderr,
    });
    return;
  }
  const headCommit = headResult.stdout.trim();
  if (!headCommit) {
    return;
  }

  const upstreamResult = await gitCommand(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    context.workingDir
  );
  if (upstreamResult.code !== 0) {
    return;
  }

  const upstreamRef = upstreamResult.stdout.trim();
  const remoteName = parseRemoteName(upstreamRef);
  if (!remoteName) {
    return;
  }

  const oldRemoteRef = `refs/remotes/${remoteName}/${context.oldBranchName}`;
  const newRemoteRef = `refs/remotes/${remoteName}/${context.newBranchName}`;

  const oldRemoteCommit = await getRefCommit(oldRemoteRef, context.workingDir);
  const newRemoteCommit = await getRefCommit(newRemoteRef, context.workingDir);
  if (!(oldRemoteCommit && newRemoteCommit)) {
    return;
  }

  // Delete the old remote branch only when both remote refs still point to HEAD.
  // This avoids deleting unexpected branch history if refs diverged.
  if (oldRemoteCommit !== headCommit || newRemoteCommit !== headCommit) {
    return;
  }

  const deleteResult = await gitCommand(
    ['push', remoteName, '--delete', context.oldBranchName],
    context.workingDir
  );
  if (deleteResult.code !== 0) {
    logger.warn('Failed to delete superseded remote branch', {
      workspaceId: context.workspaceId,
      oldBranchName: context.oldBranchName,
      remoteName,
      stderr: deleteResult.stderr,
    });
    return;
  }

  logger.info('Deleted superseded remote branch after pre-PR rename', {
    workspaceId: context.workspaceId,
    oldBranchName: context.oldBranchName,
    newBranchName: context.newBranchName,
    remoteName,
  });
}

export const prePrRenameInterceptor: ToolInterceptor = {
  name: 'pre-pr-rename',
  tools: '*',

  async onToolStart(event: ToolEvent, context: InterceptorContext): Promise<void> {
    let renameCompleted = false;
    try {
      // Check if this is a `gh pr create` command
      const command = extractCommand(event);
      if (!command) {
        return;
      }

      // Skip if already renamed this workspace
      if (renamedWorkspaces.has(context.workspaceId)) {
        return;
      }

      const workspace = await workspaceDataService.findById(context.workspaceId);
      if (!workspace) {
        return;
      }

      if (!workspace.isAutoGeneratedBranch) {
        return;
      }
      const oldBranchName = workspace.branchName ?? '';

      logger.info('Detected gh pr create with auto-generated branch, renaming', {
        workspaceId: context.workspaceId,
        currentBranch: oldBranchName,
      });

      // Mark immediately to prevent races from parallel tool calls
      renamedWorkspaces.add(context.workspaceId);

      const project = await projectManagementService.findById(workspace.projectId);
      const newBranchName = generateBranchName({
        branchPrefix: project?.githubOwner ?? '',
        workspaceName: workspace.name,
      });

      if (!newBranchName) {
        logger.warn('Could not generate branch name from workspace context', {
          workspaceId: context.workspaceId,
          workspaceName: workspace.name,
        });
        renamedWorkspaces.delete(context.workspaceId);
        return;
      }

      if (newBranchName === oldBranchName) {
        await workspaceDataService.clearAutoGeneratedBranch(context.workspaceId);
        renameCompleted = true;
        return;
      }

      // Rename the branch directly via git
      const result = await gitCommand(['branch', '-m', newBranchName], context.workingDir);
      if (result.code !== 0) {
        logger.warn('Failed to rename branch before PR creation', {
          workspaceId: context.workspaceId,
          newBranchName,
          stderr: result.stderr,
        });
        // Remove from set so it can be retried
        renamedWorkspaces.delete(context.workspaceId);
        return;
      }

      // Persist the new name and clear the auto-generated flag
      await workspaceDataService.setBranchName(context.workspaceId, newBranchName);
      await workspaceDataService.clearAutoGeneratedBranch(context.workspaceId);
      renameCompleted = true;
      if (oldBranchName) {
        remoteCleanupCandidates.set(event.toolUseId, {
          oldBranchName,
          newBranchName,
          workspaceId: context.workspaceId,
          workingDir: context.workingDir,
        });
      }

      logger.info('Renamed branch before PR creation', {
        workspaceId: context.workspaceId,
        oldBranch: oldBranchName,
        newBranch: newBranchName,
      });
    } catch (error) {
      if (!renameCompleted) {
        renamedWorkspaces.delete(context.workspaceId);
      }
      logger.error('Error in pre-PR rename interceptor', {
        workspaceId: context.workspaceId,
        error,
      });
    }
  },

  async onToolComplete(event: ToolEvent): Promise<void> {
    const candidate = remoteCleanupCandidates.get(event.toolUseId);
    if (!candidate) {
      return;
    }
    remoteCleanupCandidates.delete(event.toolUseId);

    if (event.output?.isError) {
      return;
    }

    await cleanupSupersededRemoteBranch(candidate);
  },
};
