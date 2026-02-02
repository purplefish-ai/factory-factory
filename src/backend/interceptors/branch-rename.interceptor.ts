/**
 * Branch Rename Interceptor
 *
 * Monitors Bash tool executions for `git branch -m` commands
 * and updates the workspace with the new branch name when detected.
 */

import { gitCommand } from '../lib/shell';
import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { extractInputValue, isString } from '../schemas/tool-inputs.schema';
import { createLogger } from '../services/logger.service';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('branch-rename');

export const branchRenameInterceptor: ToolInterceptor = {
  name: 'branch-rename',
  tools: ['Bash'],

  async onToolComplete(event: ToolEvent, context: InterceptorContext): Promise<void> {
    // Skip if tool execution failed
    if (event.output?.isError) {
      return;
    }

    // Check if this was a `git branch -m` command (branch rename)
    // Use regex to avoid false positives from strings containing "git branch -m"
    const command = extractInputValue(event.input, 'command', isString, 'Bash', logger);
    if (!(command && /\bgit\s+branch\s+-m\b/.test(command))) {
      return;
    }

    logger.info('Detected git branch rename command', {
      workspaceId: context.workspaceId,
      command,
    });

    // Get the current branch name from the worktree
    const result = await gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], context.workingDir);
    if (result.code !== 0) {
      logger.warn('Failed to get current branch after rename', {
        workspaceId: context.workspaceId,
        stderr: result.stderr,
      });
      return;
    }

    const newBranchName = result.stdout.trim();
    if (!newBranchName) {
      logger.warn('Empty branch name returned after rename', {
        workspaceId: context.workspaceId,
      });
      return;
    }

    // Update the workspace with the new branch name
    await workspaceAccessor.update(context.workspaceId, {
      branchName: newBranchName,
    });

    logger.info('Updated workspace with new branch name', {
      workspaceId: context.workspaceId,
      newBranchName,
    });
  },
};
