/**
 * Git Push Detection Interceptor
 *
 * Monitors Bash tool executions for `git push` commands
 * and updates the workspace's ratchetLastPushAt timestamp when detected.
 * This triggers temporary ratcheting animation in the UI.
 */

import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { extractInputValue, isString } from '../schemas/tool-inputs.schema';
import { createLogger } from '../services/logger.service';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('git-push-detection');

/**
 * Check if a command is a git push command.
 * Matches: git push, git push origin, git push -u origin HEAD, etc.
 */
function isGitPushCommand(command: string): boolean {
  // Match 'git push' with optional arguments
  // This regex matches:
  // - git push
  // - git push origin
  // - git push -u origin HEAD
  // - git push --force origin main
  // etc.
  return /\bgit\s+push\b/.test(command);
}

export const gitPushInterceptor: ToolInterceptor = {
  name: 'git-push-detection',
  tools: ['Bash'],

  async onToolComplete(event: ToolEvent, context: InterceptorContext): Promise<void> {
    // Skip if tool execution failed
    if (event.output?.isError) {
      return;
    }

    // Check if this was a `git push` command
    const command = extractInputValue(event.input, 'command', isString, 'Bash', logger);
    if (!(command && isGitPushCommand(command))) {
      return;
    }

    logger.info('Detected git push', {
      workspaceId: context.workspaceId,
      command,
    });

    // Update workspace with push timestamp to trigger temporary ratcheting animation
    await workspaceAccessor.update(context.workspaceId, {
      ratchetLastPushAt: new Date(),
    });

    logger.debug('Updated workspace ratchetLastPushAt', {
      workspaceId: context.workspaceId,
    });
  },
};
