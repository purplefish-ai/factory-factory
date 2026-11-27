/**
 * PR Detection Interceptor
 *
 * Monitors tool executions for `gh pr create` commands
 * and updates the workspace with the PR URL when detected.
 */

import { prSnapshotService } from '@/backend/services/github';
import { createLogger } from '@/backend/services/logger.service';
import { getGithubMcpCreatedPrUrl } from './github-mcp-pr-result';
import { shellCreatedPrUrls } from './shell-pr-result';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('pr-detection');
export const prDetectionInterceptor: ToolInterceptor = {
  name: 'pr-detection',
  tools: '*',
  // A sub-agent's PR belongs to the workspace even when it pushed another branch.
  observesSubagents: true,

  async onToolComplete(event: ToolEvent, context: InterceptorContext): Promise<void> {
    const mcpUrl = getGithubMcpCreatedPrUrl(event);
    const urls = mcpUrl ? [mcpUrl] : shellCreatedPrUrls(event);
    for (const prUrl of urls) {
      await attachDetectedPR(event, context, prUrl);
    }
  },
};

async function attachDetectedPR(event: ToolEvent, context: InterceptorContext, prUrl: string) {
  if (event.output?.isError) {
    logger.info('Detected PR URL in error output of gh pr create — PR may already exist', {
      workspaceId: context.workspaceId,
      prUrl,
    });
  }

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
}
