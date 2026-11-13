import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * True only when nothing is at `target` (ENOENT). An entry that exists, or a
 * lookup that fails otherwise (`ENOTDIR` under a file, `EACCES` under a
 * directory it may not search), is not "missing": the caller refuses it.
 */
function isMissing(target: string): boolean {
  try {
    return lstatSync(target, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

/**
 * Where the operating system will find `target`: the real path of its longest
 * existing prefix, with symbolic links resolved before any `..` that follows
 * them (`realpathSync.native`; `path.resolve` and `realpathSync` collapse `..`
 * first), joined with the part that does not exist yet (a clone destination).
 * Null when that part contains `..`, or when a prefix cannot be resolved for a
 * reason other than not existing (a dangling or looping link, a file in the
 * way, a directory it may not search): none of those can be placed.
 */
function resolveAsSystemWould(target: string): string | null {
  const absolute = path.isAbsolute(target) ? target : `${process.cwd()}${path.sep}${target}`;
  // `/` here, a drive or UNC root on Windows.
  const { root } = path.parse(absolute);
  const segments = absolute
    .slice(root.length)
    .split(path.sep)
    .filter((segment) => segment !== '');
  for (let length = segments.length; length >= 0; length -= 1) {
    const prefix = root + segments.slice(0, length).join(path.sep);
    let existing: string;
    try {
      existing = realpathSync.native(prefix);
    } catch {
      if (!isMissing(prefix)) {
        return null;
      }
      continue;
    }
    const rest = segments.slice(length);
    return rest.includes('..') ? null : path.join(existing, ...rest);
  }
  return null;
}

export type ProjectLocation = { valid: true; path: string } | { valid: false; error: string };

/**
 * Whether a project repository may live at `repoPath` when projects are
 * restricted to `root` (`FF_PROJECT_ROOT`), and the path to store for it. With
 * a root, real paths are compared and the real path is returned, so a symbolic
 * link cannot lead out of the root and the stored path is the checked one; the
 * root itself is not a project. Without a root, `repoPath` is returned as given.
 */
export function checkProjectLocation(repoPath: string, root: string | null): ProjectLocation {
  if (root === null) {
    return { valid: true, path: repoPath };
  }
  const realRoot = resolveAsSystemWould(root);
  const realPath = resolveAsSystemWould(repoPath);
  const relative = realRoot && realPath ? path.relative(realRoot, realPath) : '';
  const inside =
    relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
  return inside && realPath
    ? { valid: true, path: realPath }
    : { valid: false, error: `Path ${repoPath} is outside the project root ${root}` };
}
