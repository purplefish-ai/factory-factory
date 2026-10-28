import type { z } from 'zod';
import type { githubCLIService } from '@/backend/services/github';
import type { projectManagementService } from '@/backend/services/workspace';
import { type SearchInputSchema, SearchResultSchema, type SearchResult } from '@/shared/search';

interface GitHubIssueSearchPorts {
  listProjects: typeof projectManagementService.list;
  searchIssues: typeof githubCLIService.searchIssues;
}

export async function searchGitHubIssues(
  input: z.output<typeof SearchInputSchema>,
  ports: GitHubIssueSearchPorts
) {
  if (!input.query) {
    return { results: [], errors: [] };
  }
  const { listProjects, searchIssues } = ports;
  const projects = await listProjects({ isArchived: false });
  const searches = await Promise.all(
    projects.map(async (project) => {
      if (!(project.githubOwner && project.githubRepo)) {
        return { results: [], errors: [] };
      }
      try {
        const issues = await searchIssues(
          project.githubOwner,
          project.githubRepo,
          input.query,
          input.limit
        );
        return {
          results: issues.map((issue) =>
            SearchResultSchema.parse({
              kind: 'github_issue',
              id: `${project.id}:${issue.number}`,
              title: issue.title,
              subtitle: `${project.name} · ${project.githubOwner}/${project.githubRepo} · Issue #${issue.number}${issue.state === 'CLOSED' ? ' · Closed' : ''}`,
              projectId: project.id,
              projectSlug: project.slug,
              workspaceId: null,
              sessionId: null,
              archived: false,
              githubIssue: issue,
            })
          ),
          errors: [],
        };
      } catch (error) {
        return {
          results: [],
          errors: [
            `${project.name}: ${error instanceof Error ? error.message : 'Could not search GitHub issues'}`,
          ],
        };
      }
    })
  );
  return {
    results: searches.flatMap((search): SearchResult[] => search.results).slice(0, input.limit),
    errors: searches.flatMap((search) => search.errors),
  };
}
