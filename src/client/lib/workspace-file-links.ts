function stripLineSuffix(pathname: string): string {
  return pathname.replace(/(?::\d+){1,2}$/, '');
}

function appendNormalizedSegment(
  segments: string[],
  segment: string,
  hasLeadingSlash: boolean
): void {
  if (!segment || segment === '.') {
    return;
  }

  if (segment === '..') {
    const previousSegment = segments[segments.length - 1];
    if (segments.length > 0 && previousSegment !== '..') {
      segments.pop();
    } else if (!hasLeadingSlash) {
      segments.push(segment);
    }
    return;
  }

  segments.push(segment);
}

function normalizePathForComparison(pathname: string, usesWindowsPathSemantics: boolean): string {
  const normalizedInput = usesWindowsPathSemantics ? pathname.replace(/\\/g, '/') : pathname;
  const hasLeadingSlash =
    normalizedInput.startsWith('/') ||
    (usesWindowsPathSemantics && /^[A-Za-z]:\//.test(normalizedInput));
  const segments: string[] = [];

  for (const segment of normalizedInput.split('/')) {
    appendNormalizedSegment(segments, segment, hasLeadingSlash);
  }

  const normalized = `${hasLeadingSlash ? '/' : ''}${segments.join('/')}`.replace(/\/+$/, '');
  if (normalized) {
    return normalized;
  }

  return hasLeadingSlash ? '/' : '.';
}

function decodeRawPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function getPathnameFromHref(href: string, origin?: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  // `new URL` would parse a bare Windows path such as `C:/repo` as a URL with
  // protocol `c:`, so treat drive-letter paths as raw paths. Drop any query or
  // fragment, as the URL branch does via `url.pathname`.
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return decodeRawPath(trimmed.split(/[?#]/, 1)[0] ?? trimmed);
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
    return decodeRawPath(trimmed);
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

  const usesWindowsPathSemantics = /^[A-Za-z]:[\\/]/.test(worktreePath);
  const filePath = normalizePathForComparison(stripLineSuffix(pathname), usesWindowsPathSemantics);
  const workspaceRoot = normalizePathForComparison(worktreePath, usesWindowsPathSemantics);
  const comparableFilePath = usesWindowsPathSemantics ? filePath.toLowerCase() : filePath;
  const comparableWorkspaceRoot = usesWindowsPathSemantics
    ? workspaceRoot.toLowerCase()
    : workspaceRoot;
  if (
    !(
      comparableFilePath === comparableWorkspaceRoot ||
      comparableFilePath.startsWith(`${comparableWorkspaceRoot}/`)
    )
  ) {
    return null;
  }

  const relativePath = filePath.slice(workspaceRoot.length).replace(/^\/+/, '');
  return relativePath.length > 0 ? relativePath : null;
}
