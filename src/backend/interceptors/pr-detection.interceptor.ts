/**
 * PR Detection Interceptor
 *
 * Monitors tool executions for `gh pr create` commands
 * and updates the workspace with the PR URL when detected.
 */

import { extractInputValue, isString } from '@/backend/schemas/tool-inputs.schema';
import { prSnapshotService } from '@/backend/services/github';
import { createLogger } from '@/backend/services/logger.service';
import type { InterceptorContext, ToolEvent, ToolInterceptor } from './types';

const logger = createLogger('pr-detection');
const GH_PR_CREATE_REGEX = /\bgh\s+pr\s+create\b/;
const GITHUB_PR_URL_REGEX = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const GITHUB_CREATE_PULL_REQUEST_TOOL = 'github_create_pull_request';
const CREATE_PULL_REQUEST_TOOL = 'create_pull_request';
const OFFICIAL_GITHUB_MCP_SERVERS = new Set(['github', 'codex_apps']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractCommand(event: ToolEvent): string | undefined {
  const directCommand = extractInputValue(event.input, 'command', isString, event.toolName, logger);
  if (directCommand && GH_PR_CREATE_REGEX.test(directCommand)) {
    return directCommand;
  }

  const cmd = extractInputValue(event.input, 'cmd', isString, event.toolName, logger);
  if (cmd && GH_PR_CREATE_REGEX.test(cmd)) {
    return cmd;
  }

  const title = extractInputValue(event.input, 'title', isString, event.toolName, logger);
  if (title && GH_PR_CREATE_REGEX.test(title)) {
    return title;
  }

  // Some providers may set toolName to the command text.
  if (GH_PR_CREATE_REGEX.test(event.toolName)) {
    return event.toolName;
  }

  return directCommand ?? cmd ?? title;
}

function extractMcpToolNameFromDisplayName(toolName: string): string | undefined {
  const slashIndex = toolName.lastIndexOf('/');
  if (slashIndex === -1 || slashIndex === toolName.length - 1) {
    return undefined;
  }
  return toolName.slice(slashIndex + 1);
}

function extractMcpServerNameFromDisplayName(toolName: string): string | undefined {
  const prefix = 'mcpToolCall:';
  if (!toolName.startsWith(prefix)) {
    return undefined;
  }

  const slashIndex = toolName.indexOf('/', prefix.length);
  if (slashIndex === -1) {
    return undefined;
  }

  return toolName.slice(prefix.length, slashIndex);
}

function isOfficialGithubMcpServer(serverName: string): boolean {
  return OFFICIAL_GITHUB_MCP_SERVERS.has(serverName.toLowerCase());
}

function isGithubCreatePullRequestTool(event: ToolEvent): boolean {
  const inputTool = extractInputValue(event.input, 'tool', isString, event.toolName, logger);
  if (inputTool === GITHUB_CREATE_PULL_REQUEST_TOOL) {
    return true;
  }

  const inputServer = extractInputValue(event.input, 'server', isString, event.toolName, logger);
  if (
    inputTool === CREATE_PULL_REQUEST_TOOL &&
    inputServer &&
    isOfficialGithubMcpServer(inputServer)
  ) {
    return true;
  }

  const displayToolName = extractMcpToolNameFromDisplayName(event.toolName) ?? event.toolName;
  if (displayToolName === GITHUB_CREATE_PULL_REQUEST_TOOL) {
    return true;
  }

  const displayServerName = extractMcpServerNameFromDisplayName(event.toolName);
  if (
    displayToolName === CREATE_PULL_REQUEST_TOOL &&
    displayServerName &&
    isOfficialGithubMcpServer(displayServerName)
  ) {
    return true;
  }

  return false;
}

function extractPrUrlFromEvent(event: ToolEvent): string | null {
  const candidates: string[] = [];

  if (event.output?.content) {
    candidates.push(event.output.content);
  }

  const aggregatedOutput = extractInputValue(
    event.input,
    'aggregatedOutput',
    isString,
    event.toolName,
    logger
  );
  if (aggregatedOutput) {
    candidates.push(aggregatedOutput);
  }

  const rawOutput = event.input.rawOutput;
  if (isString(rawOutput)) {
    candidates.push(rawOutput);
  } else if (isRecord(rawOutput)) {
    const nestedAggregatedOutput = extractInputValue(
      rawOutput,
      'aggregatedOutput',
      isString,
      event.toolName,
      logger
    );
    if (nestedAggregatedOutput) {
      candidates.push(nestedAggregatedOutput);
    }
    candidates.push(JSON.stringify(rawOutput));
  }

  for (const candidate of candidates) {
    const match = candidate.match(GITHUB_PR_URL_REGEX);
    if (match) {
      return match[0];
    }
  }

  return null;
}

export const prDetectionInterceptor: ToolInterceptor = {
  name: 'pr-detection',
  tools: '*',

  async onToolComplete(event: ToolEvent, context: InterceptorContext): Promise<void> {
    // Check if this was a `gh pr create` command.
    // Note: we intentionally do NOT skip on isError here. `gh pr create` can exit
    // non-zero (e.g. "A pull request for branch 'x' already exists") while still
    // printing the PR URL in its output. We only bail if no URL is found.
    const command = extractCommand(event);
    const isGhPrCreate = command ? GH_PR_CREATE_REGEX.test(command) : false;
    const isMcpPrCreate = isGithubCreatePullRequestTool(event);
    if (!(isGhPrCreate || isMcpPrCreate)) {
      return;
    }

    // Extract PR URL from output regardless of error status
    const prUrl = extractPrUrlFromEvent(event);
    if (!prUrl) {
      logger.debug('No PR URL found in gh pr create output', {
        workspaceId: context.workspaceId,
        toolName: event.toolName,
        isError: event.output?.isError,
      });
      return;
    }

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
  },
};
