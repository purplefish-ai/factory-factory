function stripLineSuffix(pathname: string): string {
  return pathname.replace(/(?::\d+){1,2}$/, '');
}

function normalizePathForComparison(pathname: string): string {
  return pathname.replace(/\/+$/, '');
}

function getPathnameFromHref(href: string, origin?: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const base = origin ?? 'http://localhost';
    const url = new URL(trimmed, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
      return null;
    }
    if (origin && url.origin !== origin && url.protocol !== 'file:') {
      return null;
    }
    return decodeURIComponent(url.pathname);
  } catch {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  }
}

export function resolveWorkspaceFileLink(
  href: string | undefined,
  worktreePath: string | null | undefined,
  origin = typeof window !== 'undefined' ? window.location.origin : undefined
): string | null {
  if (!(href && worktreePath)) {
    return null;
  }

  const pathname = getPathnameFromHref(href, origin);
  if (!pathname) {
    return null;
  }

  const filePath = normalizePathForComparison(stripLineSuffix(pathname));
  const workspaceRoot = normalizePathForComparison(worktreePath);
  if (!(filePath === workspaceRoot || filePath.startsWith(`${workspaceRoot}/`))) {
    return null;
  }

  const relativePath = filePath.slice(workspaceRoot.length).replace(/^\/+/, '');
  return relativePath.length > 0 ? relativePath : null;
}
