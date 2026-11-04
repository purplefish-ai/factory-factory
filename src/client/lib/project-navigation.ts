export type ProjectSection = 'workspaces' | 'agents' | 'reviews';

/** Canonical project URLs. Segment encoding keeps IDs out of path structure. */
export function getProjectSectionPath(slug: string, section: ProjectSection): string {
  return `/projects/${encodeURIComponent(slug)}/${section}`;
}

export type AgentKind = 'scheduled' | 'event';

export function getProjectAgentPath(
  slug: string,
  id: string,
  kind: AgentKind = 'scheduled'
): string {
  return `${getProjectSectionPath(slug, 'agents')}/${encodeURIComponent(id)}${kind === 'event' ? '?kind=event' : ''}`;
}

/** An explicit malformed discriminator must never fall back to a different owner. */
export function getAgentRouteKind(search: string): AgentKind | null {
  const values = new URLSearchParams(search).getAll('kind');
  if (values.length === 0) {
    return 'scheduled';
  }
  if (values.length !== 1) {
    return null;
  }
  return values[0] === 'scheduled' || values[0] === 'event' ? values[0] : null;
}

export function getProjectSection(pathname: string): ProjectSection | null {
  const section = /^\/projects\/[^/]+\/(workspaces|agents|reviews)(?:\/|$)/i
    .exec(pathname)?.[1]
    ?.toLowerCase();
  return section === 'workspaces' || section === 'agents' || section === 'reviews' ? section : null;
}

/** The board is the project landing page; workspace detail routes sit below it. */
export function isProjectBoardPath(pathname: string): boolean {
  return /^\/projects\/[^/]+\/workspaces\/?$/i.test(pathname);
}

/** Search parameter that asks the board to open its new workspace form once. */
export const NEW_WORKSPACE_SEARCH_PARAM = 'new';

/** Board URL that opens the new workspace form; replaces the removed `/workspaces/new` page. */
export function getProjectNewWorkspacePath(slug: string): string {
  return `${getProjectSectionPath(slug, 'workspaces')}?${NEW_WORKSPACE_SEARCH_PARAM}=1`;
}

/** Explicit legacy owners must resolve before the root onboarding redirect. */
export function hasExplicitLegacyProjectOwner(pathname: string, search: string): boolean {
  return (
    /^\/agents\/[^/]+\/?$/i.test(pathname) ||
    (/^\/reviews\/?$/i.test(pathname) && !!new URLSearchParams(search).get('repo'))
  );
}
