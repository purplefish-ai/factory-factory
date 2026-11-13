import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the operating system will find `target`: the real path of its longest
 * existing prefix, with symbolic links resolved before any `..` that follows
 * them (`realpathSync.native`; `path.resolve` and `realpathSync` collapse `..`
 * first), joined with the part that does not exist yet (a clone destination).
 * Null when that part contains `..`, which cannot be resolved before it exists.
 */
function resolveAsSystemWould(target: string): string | null {
  const absolute = path.isAbsolute(target) ? target : `${process.cwd()}${path.sep}${target}`;
  const segments = absolute.split(path.sep).filter((segment) => segment !== '');
  for (let length = segments.length; length >= 0; length -= 1) {
    let existing: string;
    try {
      existing = realpathSync.native(path.sep + segments.slice(0, length).join(path.sep));
    } catch {
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
