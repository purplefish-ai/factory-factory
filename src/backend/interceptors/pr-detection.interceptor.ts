/**
 * PR Detection Interceptor
 *
 * Monitors Bash tool executions for `gh pr create` commands
 * and updates the workspace with the PR URL when detected.
 */

import { workspaceAccessor } from '../resource_accessors/workspace.accessor';
import { githubCLIService } from '../services/github-cli.service';
import { createLogger } from '../services/logger.service';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('pr-detection');

export const prDetectionInterceptor: ToolInterceptor = {
  name: 'pr-detection',
  tools: ['Bash'],

  async onToolComplete(event: ToolEvent, context: InterceptorContext): Promise<void> {
    // Skip if tool execution failed
    if (event.output?.isError) {
      return;
    }

    // Check if this was a `gh pr create` command
    const command = event.input.command as string | undefined;
    if (!command?.includes('gh pr create')) {
      return;
    }

    // Extract PR URL from output
    const output = event.output?.content ?? '';
    const prUrlMatch = output.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);

    if (!prUrlMatch) {
      logger.debug('No PR URL found in gh pr create output', {
        workspaceId: context.workspaceId,
        outputLength: output.length,
      });
      return;
    }

    const prUrl = prUrlMatch[0];
    logger.info('Detected PR creation', {
      workspaceId: context.workspaceId,
      prUrl,
    });

    // Fetch PR details from GitHub
    const prResult = await githubCLIService.fetchAndComputePRState(prUrl);

    if (!prResult) {
      // Still update the URL even if we couldn't fetch details
      await workspaceAccessor.update(context.workspaceId, {
        prUrl,
        prUpdatedAt: new Date(),
      });
      logger.warn('Updated workspace with PR URL but could not fetch PR details', {
        workspaceId: context.workspaceId,
        prUrl,
      });
      return;
    }

    // Update workspace with full PR details
    await workspaceAccessor.update(context.workspaceId, {
      prUrl,
      prNumber: prResult.prNumber,
      prState: prResult.prState,
      prReviewState: prResult.prReviewState,
      prCiStatus: prResult.prCiStatus,
      prUpdatedAt: new Date(),
    });

    logger.info('Updated workspace with PR details', {
      workspaceId: context.workspaceId,
      prUrl,
      prNumber: prResult.prNumber,
      prState: prResult.prState,
    });
  },
};
