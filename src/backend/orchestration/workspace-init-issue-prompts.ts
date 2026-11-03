import type { createLogger } from '@/backend/services/logger.service';
import { workspaceDataService } from '@/backend/services/workspace';
import { buildIssueStartPrompt } from '@/shared/issue-start-prompt';

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
    const url =
      workspace.githubIssueUrl ||
      (project?.githubOwner && project.githubRepo
        ? `https://github.com/${project.githubOwner}/${project.githubRepo}/issues/${workspace.githubIssueNumber}`
        : null);
    return url ? buildIssueStartPrompt({ url }) : '';
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
    if (!(workspace?.linearIssueId && workspace.linearIssueUrl)) {
      return '';
    }
    return buildIssueStartPrompt({ url: workspace.linearIssueUrl });
  } catch (error) {
    logger.warn('Error building initial prompt from Linear issue', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
