import { githubCLIService } from '@/backend/services/github';
import { linearClientService } from '@/backend/services/linear';
import type { createLogger } from '@/backend/services/logger.service';
import { workspaceDataService } from '@/backend/services/workspace';
import { buildIssueStartPrompt } from '@/shared/issue-start-prompt';
import { getDecryptedLinearConfig } from './linear-config.helper';

type Logger = ReturnType<typeof createLogger>;

export async function buildInitialPromptFromGitHubIssue(
  workspaceId: string,
  logger: Logger
): Promise<string> {
  try {
    const workspace = await workspaceDataService.findByIdWithProject(workspaceId);
    if (!workspace?.githubIssueNumber) {
      return '';
    }

    const project = workspace.project;
    if (!(project?.githubOwner && project?.githubRepo)) {
      return '';
    }

    const issue = await githubCLIService.getIssue(
      project.githubOwner,
      project.githubRepo,
      workspace.githubIssueNumber
    );

    if (!issue) {
      logger.warn('Failed to fetch GitHub issue for initial prompt', {
        workspaceId,
        issueNumber: workspace.githubIssueNumber,
      });
      return '';
    }

    logger.info('Built initial prompt from GitHub issue', {
      workspaceId,
      issueNumber: issue.number,
      issueTitle: issue.title,
    });

    return buildIssueStartPrompt({
      providerLabel: 'GitHub Issue',
      issueReference: `#${issue.number}`,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      commitReference: `#${issue.number}`,
      closeReference: `#${issue.number}`,
      rawScreenshotBaseUrl: `https://raw.githubusercontent.com/${project.githubOwner}/${project.githubRepo}/`,
    });
  } catch (error) {
    logger.warn('Error building initial prompt from GitHub issue', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

export async function buildInitialPromptFromLinearIssue(
  workspaceId: string,
  logger: Logger
): Promise<string> {
  try {
    const workspace = await workspaceDataService.findByIdWithProject(workspaceId);
    if (!workspace?.linearIssueId) {
      return '';
    }

    const project = workspace.project;
    const linearConfig = getDecryptedLinearConfig(project.issueTrackerConfig);
    if (!linearConfig) {
      return '';
    }

    const issue = await linearClientService.getIssue(linearConfig.apiKey, workspace.linearIssueId);
    if (!issue) {
      logger.warn('Failed to fetch Linear issue for initial prompt', {
        workspaceId,
        linearIssueId: workspace.linearIssueId,
      });
      return '';
    }

    logger.info('Built initial prompt from Linear issue', {
      workspaceId,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
    });

    return buildIssueStartPrompt({
      providerLabel: 'Linear Issue',
      issueReference: issue.identifier,
      title: issue.title,
      body: issue.description,
      url: issue.url,
      commitReference: issue.identifier,
      closeReference: issue.identifier,
      rawScreenshotBaseUrl: `https://raw.githubusercontent.com/${project.githubOwner}/${project.githubRepo}/`,
    });
  } catch (error) {
    logger.warn('Error building initial prompt from Linear issue', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
