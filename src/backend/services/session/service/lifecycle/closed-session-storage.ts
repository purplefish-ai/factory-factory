import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { configService } from '@/backend/services/config.service';

export function archiveDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function closedSessionArchivesDirectory(): string {
  return join(configService.getBaseDir(), 'closed-sessions');
}

export function closedSessionWorkspaceDirectory(workspaceId: string): string {
  return join(closedSessionArchivesDirectory(), archiveDigest(workspaceId));
}

export function closedSessionArchivePath(
  workspaceId: string,
  id: string,
  transcriptHash: string
): string {
  return join('closed-sessions', archiveDigest(workspaceId), `${id}.${transcriptHash}.json`);
}

/** Explicit storage discriminator preserves legacy worktree-relative paths. */
export function resolveClosedSessionTranscriptPath(
  archive: {
    id?: string;
    archiveKey?: string | null;
    workspaceId?: string;
    transcriptHash?: string | null;
    transcriptPath: string;
  },
  worktreePath: string | null
): string {
  if (archive.archiveKey) {
    if (
      !(
        archive.workspaceId &&
        archive.id &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(archive.id) &&
        archive.transcriptHash &&
        /^[a-f0-9]{64}$/.test(archive.transcriptHash) &&
        /^[a-f0-9]{64}$/.test(archive.archiveKey)
      ) ||
      archive.transcriptPath !==
        closedSessionArchivePath(archive.workspaceId, archive.id, archive.transcriptHash)
    ) {
      throw new Error('Invalid owned transcript path');
    }
    return join(configService.getBaseDir(), archive.transcriptPath);
  }
  if (!worktreePath) {
    throw new Error('Workspace has no worktree path');
  }
  const path = resolve(worktreePath, archive.transcriptPath);
  const within = relative(resolve(worktreePath), path);
  if (within.startsWith('..') || resolve(worktreePath) === path) {
    throw new Error('Invalid legacy transcript path');
  }
  return path;
}

/** Called only after the Workspace cascade commits; archiving a worktree never calls it. */
export function removeClosedSessionWorkspaceDirectory(workspaceId: string): void {
  rmSync(closedSessionWorkspaceDirectory(workspaceId), { recursive: true, force: true });
}
