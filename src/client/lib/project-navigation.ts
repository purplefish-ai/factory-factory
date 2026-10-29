export type ProjectSection = 'workspaces' | 'agents' | 'reviews';

/** Canonical project URLs. Segment encoding keeps IDs out of path structure. */
export function getProjectSectionPath(slug: string, section: ProjectSection): string {
  return `/projects/${encodeURIComponent(slug)}/${section}`;
}

export function getProjectAgentPath(slug: string, id: string): string {
  return `${getProjectSectionPath(slug, 'agents')}/${encodeURIComponent(id)}`;
}

export function getProjectSection(pathname: string): ProjectSection | null {
  const section = /^\/projects\/[^/]+\/(workspaces|agents|reviews)(?:\/|$)/i
    .exec(pathname)?.[1]
    ?.toLowerCase();
  return section === 'workspaces' || section === 'agents' || section === 'reviews' ? section : null;
}

/** Explicit legacy owners must resolve before the root onboarding redirect. */
export function hasExplicitLegacyProjectOwner(pathname: string, search: string): boolean {
  return (
    /^\/agents\/[^/]+\/?$/i.test(pathname) ||
    (/^\/reviews\/?$/i.test(pathname) && !!new URLSearchParams(search).get('repo'))
  );
}
