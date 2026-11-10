/**
 * Classifies filesystem events in a repository's common `.git` directory and
 * matches ref changes against the refs a linked worktree's snapshot read.
 */

/** What a change in the common Git directory means for dependent snapshots. */
export type SharedGitEvent = { kind: 'ignore' } | { kind: 'all' } | { kind: 'ref'; ref: string };

const SCOPED_SHARED_REF_PATH = /^refs\/(?:heads|remotes|tags)(?:\/|$)/;

// Upstream lookup failures that only branch config or the worktree's private
// HEAD can change. Any other failure, such as a configured upstream whose
// tracking ref is missing, leaves a snapshot's ref dependencies unknown.
const REF_INDEPENDENT_UPSTREAM_FAILURES = [
  /no upstream configured for branch/,
  /HEAD does not point to a branch/,
];

function isUnobservedSharedGitPath(normalized: string): boolean {
  // Worktree metadata is covered by its private watcher. Object and reflog
  // writes are high-volume side effects of ref changes, which arrive through
  // the remaining shared metadata paths. Git takes the packed-refs lock for
  // ordinary loose ref updates such as commits and pushes, then releases it
  // without touching packed-refs; a real rewrite renames `packed-refs.new`
  // onto `packed-refs`, and both of those names still invalidate everyone.
  return (
    normalized === 'packed-refs.lock' ||
    normalized === 'HEAD' ||
    normalized.startsWith('HEAD.') ||
    normalized === 'index' ||
    normalized.startsWith('index.') ||
    normalized === 'config.worktree' ||
    normalized.startsWith('config.worktree.') ||
    normalized === 'worktrees' ||
    normalized.startsWith('worktrees/') ||
    normalized === 'objects' ||
    normalized.startsWith('objects/') ||
    normalized === 'logs' ||
    normalized.startsWith('logs/')
  );
}

/**
 * Loose refs fold case and Unicode normalization on some filesystems; fold
 * both sides of every comparison so a matching event is never missed.
 */
export function normalizeRefName(ref: string): string {
  return ref.normalize('NFC').toLowerCase();
}

/**
 * Classify a path (relative to the common Git directory) reported by its
 * watcher. A null filename means the platform could not say what changed.
 */
export function classifySharedGitEvent(filename: string | null): SharedGitEvent {
  if (!filename) {
    return { kind: 'all' };
  }

  const normalized = filename.replaceAll('\\', '/').replace(/^\.\//, '');
  if (isUnobservedSharedGitPath(normalized)) {
    return { kind: 'ignore' };
  }
  // Snapshots name branches, remote-tracking branches and (through revision
  // lookup) tags, so those loose refs can be matched against what each
  // snapshot read. A ref's lock file stands for the ref: no ref name may end
  // in `.lock`. packed-refs, reftable storage, other ref namespaces such as
  // refs/replace, config and anything unrecognized still affect everyone.
  if (SCOPED_SHARED_REF_PATH.test(normalized)) {
    return { kind: 'ref', ref: normalizeRefName(normalized.replace(/\.lock$/, '')) };
  }
  return { kind: 'all' };
}

/**
 * The full refs Git may resolve a revision name to, following
 * `ref_rev_parse_rules`. Names outside `refs/` resolve in the worktree's
 * private directory and are omitted.
 */
export function revisionRefCandidates(revision: string): string[] {
  return [
    revision,
    `refs/${revision}`,
    `refs/tags/${revision}`,
    `refs/heads/${revision}`,
    `refs/remotes/${revision}`,
    `refs/remotes/${revision}/HEAD`,
  ].filter((ref) => ref.startsWith('refs/'));
}

/**
 * Whether a failed `rev-parse @{upstream}` lookup can only change through
 * branch config or the private HEAD, never through a ref write.
 */
export function isRefIndependentUpstreamFailure(stderr: string): boolean {
  return REF_INDEPENDENT_UPSTREAM_FAILURES.some((failure) => failure.test(stderr));
}

/**
 * Whether a changed ref path can alter a snapshot that read the normalized
 * `dependencies`. A directory path covers every ref beneath it, and a ref
 * beneath a dependency means that dependency turned into a directory.
 */
export function refChangeAffects(changedRef: string, dependencies: ReadonlySet<string>): boolean {
  for (const dependency of dependencies) {
    if (
      dependency === changedRef ||
      dependency.startsWith(`${changedRef}/`) ||
      changedRef.startsWith(`${dependency}/`)
    ) {
      return true;
    }
  }
  return false;
}
