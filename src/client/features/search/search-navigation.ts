import type { SearchResult } from '@/shared/search';

export function getSearchResultUrl(
  result: Pick<SearchResult, 'kind' | 'projectSlug' | 'workspaceId' | 'sessionId'>
): string {
  const base = `/projects/${encodeURIComponent(result.projectSlug)}/workspaces`;
  if (!result.workspaceId) {
    return base;
  }
  const workspace = `${base}/${encodeURIComponent(result.workspaceId)}`;
  return result.sessionId
    ? `${workspace}?session=${encodeURIComponent(result.sessionId)}`
    : workspace;
}
