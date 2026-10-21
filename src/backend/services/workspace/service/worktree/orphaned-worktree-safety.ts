import { readdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';

/** Resolve existing ancestors too, so a missing child still honors base symlinks. */
export async function canonicalPath(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    const parent = path.dirname(absolutePath);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === absolutePath) {
      throw error;
    }
    return path.join(await canonicalPath(parent), path.basename(absolutePath));
  }
}

export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Only a registered linked worktree's root .git file may be deleted. Nested
 * repositories (including bare repositories) can own otherwise unrecoverable
 * commits. Never follow symlinks, and let unreadable trees fail closed.
 */
export async function isSafeWorktreeDirectory(
  worktreePath: string,
  registered: boolean
): Promise<boolean> {
  const pending = [worktreePath];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    const gitEntry = entries.find((entry) => entry.name === '.git');
    if (gitEntry && !(directory === worktreePath && registered && gitEntry.isFile())) {
      return false;
    }
    // Bare Git repositories have no .git marker. Preserve their object store.
    if (
      entries.some((entry) => entry.name === 'HEAD') &&
      entries.some((entry) => entry.name === 'objects' && entry.isDirectory()) &&
      entries.some((entry) => entry.name === 'refs' && entry.isDirectory())
    ) {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(path.join(directory, entry.name));
      }
    }
  }
  return true;
}
