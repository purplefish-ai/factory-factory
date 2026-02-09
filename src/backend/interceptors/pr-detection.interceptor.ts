/**
 * PR Detection Interceptor
 *
 * Monitors Bash tool executions for `gh pr create` commands
 * and updates the workspace with the PR URL when detected.
 */

import { extractInputValue, isString } from '../schemas/tool-inputs.schema';
import { createLogger } from '../services/logger.service';
import { prSnapshotService } from '../services/pr-snapshot.service';
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
    const command = extractInputValue(event.input, 'command', isString, 'Bash', logger);
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

    // Route through PRSnapshotService for canonical PR attachment
    const result = await prSnapshotService.attachAndRefreshPR(context.workspaceId, prUrl);

    if (!result.success) {
      if (result.reason === 'fetch_failed') {
        logger.warn('Attached PR URL but could not fetch snapshot details', {
          workspaceId: context.workspaceId,
          prUrl,
        });
      } else {
        logger.warn('Failed to attach PR and refresh snapshot', {
          workspaceId: context.workspaceId,
          prUrl,
          reason: result.reason,
        });
      }
      return;
    }

    logger.info('Attached PR and updated workspace snapshot', {
      workspaceId: context.workspaceId,
      prUrl,
      prNumber: result.snapshot.prNumber,
      prState: result.snapshot.prState,
    });
  },
};
