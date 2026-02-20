/**
 * Pre-PR Branch Rename Interceptor
 *
 * Detects `gh pr create` on tool start and renames auto-generated branches
 * to meaningful names before the PR is created. Uses direct `git branch -m`
 * so the rename completes before the network-bound `gh pr create` executes.
 */

import { projectManagementService, workspaceDataService } from '@/backend/domains/workspace';
import { gitCommand } from '@/backend/lib/shell';
import { createLogger } from '@/backend/services/logger.service';
import { extractMatchingCommand, generateBranchName } from './branch-rename.utils';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('pre-pr-rename');
const GH_PR_CREATE_REGEX = /\bgh\s+pr\s+create\b/;
const MAX_REMOTE_CLEANUP_CANDIDATES = 1000;

// Track workspaces that have already been renamed to avoid duplicate renames
const renamedWorkspaces = new Set<string>();
type RemoteCleanupCandidate = {
  oldBranchName: string;
  newBranchName: string;
  workspaceId: string;
  workingDir: string;
};
const remoteCleanupCandidates = new Map<string, RemoteCleanupCandidate>();

export { generateBranchName };

function setRemoteCleanupCandidate(toolUseId: string, candidate: RemoteCleanupCandidate): void {
  if (remoteCleanupCandidates.has(toolUseId)) {
    remoteCleanupCandidates.delete(toolUseId);
  }

  while (remoteCleanupCandidates.size >= MAX_REMOTE_CLEANUP_CANDIDATES) {
    const oldestToolUseId = remoteCleanupCandidates.keys().next().value;
    if (!oldestToolUseId) {
      break;
    }
    remoteCleanupCandidates.delete(oldestToolUseId);
  }

  remoteCleanupCandidates.set(toolUseId, candidate);
}

function parseRemoteName(upstreamRef: string): string | undefined {
  const slashIndex = upstreamRef.indexOf('/');
  if (slashIndex <= 0) {
    return undefined;
  }
  return upstreamRef.slice(0, slashIndex);
}

function normalizeRemoteBranchName(branchName: string, remoteName: string): string {
  const remotePrefix = `${remoteName}/`;
  if (branchName.startsWith(remotePrefix)) {
    return branchName.slice(remotePrefix.length);
  }

  const fullRefPrefix = `refs/remotes/${remoteName}/`;
  if (branchName.startsWith(fullRefPrefix)) {
    return branchName.slice(fullRefPrefix.length);
  }

  return branchName;
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

  const oldRemoteBranchName = normalizeRemoteBranchName(context.oldBranchName, remoteName);
  const newRemoteBranchName = normalizeRemoteBranchName(context.newBranchName, remoteName);
  if (!(oldRemoteBranchName && newRemoteBranchName)) {
    return;
  }

  if (oldRemoteBranchName === newRemoteBranchName) {
    return;
  }

  const oldRemoteRef = `refs/remotes/${remoteName}/${oldRemoteBranchName}`;
  const newRemoteRef = `refs/remotes/${remoteName}/${newRemoteBranchName}`;

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
    ['push', remoteName, '--delete', oldRemoteBranchName],
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
      const command = extractMatchingCommand(event, GH_PR_CREATE_REGEX, logger);
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
        setRemoteCleanupCandidate(event.toolUseId, {
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

    try {
      await cleanupSupersededRemoteBranch(candidate);
    } catch (error) {
      logger.error('Error cleaning up superseded remote branch', {
        workspaceId: candidate.workspaceId,
        toolUseId: event.toolUseId,
        error,
      });
    }
  },
};
