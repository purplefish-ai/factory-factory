import type { createLogger } from '@/backend/services/logger.service';
import { userSettingsService } from '@/backend/services/settings';
import { workspaceDataService } from '@/backend/services/workspace';
import { buildIssueStartPrompt } from '@/shared/issue-start-prompt';

type Logger = ReturnType<typeof createLogger>;

async function buildConfiguredIssuePrompt(url: string, logger: Logger): Promise<string> {
  try {
    const settings = await userSettingsService.get();
    return buildIssueStartPrompt({ url, prompt: settings.ticketDispatchPrompt });
  } catch (error) {
    logger.warn('Could not read ticket dispatch settings; using default prompt', {
      error: error instanceof Error ? error.message : String(error),
    });
    return buildIssueStartPrompt({ url });
  }
}

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
    if (!url) {
      return '';
    }
    return await buildConfiguredIssuePrompt(url, logger);
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
    return await buildConfiguredIssuePrompt(workspace.linearIssueUrl, logger);
  } catch (error) {
    logger.warn('Error building initial prompt from Linear issue', {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
