import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * The real path of `target`, or, when it does not exist yet (a clone
 * destination), its nearest existing ancestor's real path joined with the rest.
 */
function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  let existing = absolute;
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), path.relative(existing, absolute));
}

/**
 * Whether a project repository may live at `repoPath` when projects are
 * restricted to `root` (`FF_PROJECT_ROOT`). Real paths are compared, so a
 * symbolic link cannot lead out of the root; the root itself is not a project.
 */
export function checkProjectLocation(
  repoPath: string,
  root: string | null
): { valid: true } | { valid: false; error: string } {
  if (root === null) {
    return { valid: true };
  }
  const relative = path.relative(resolveRealPath(root), resolveRealPath(repoPath));
  const inside =
    relative !== '' && !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
  return inside
    ? { valid: true }
    : { valid: false, error: `Path ${repoPath} is outside the project root ${root}` };
}
