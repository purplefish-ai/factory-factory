import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { z } from 'zod';
import { ApplicationError } from '@/backend/lib/application-error';
import { closedSessionAccessor } from '@/backend/services/session/resources/closed-session.accessor';
import { parseClosedSessionReadTranscript } from '@/shared/acp-protocol/protocol/closed-session-transcript-schema';
import { readClosedSessionTranscriptHeader } from './closed-session-transcript-header';

const providerIdentitySchema = z.object({
  provider: z.enum(['CLAUDE', 'CODEX']),
  providerSessionId: z.string().min(1),
  // Absence is unknown; null explicitly identifies the legacy default account.
  codexAccountId: z.string().min(1).nullish(),
});

export type ArchivedProviderIdentity = z.infer<typeof providerIdentitySchema> & {
  workingDir: string;
};

function requireContainedPath(root: string, file: string): void {
  const difference = relative(root, file);
  if (difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    throw new ApplicationError('INVALID_INPUT', 'Invalid closed session transcript path');
  }
}

async function findTranscriptFile(id: string) {
  const archive = await closedSessionAccessor.findByIdWithWorkspace(id);
  if (!archive) {
    throw new ApplicationError('NOT_FOUND', 'Closed session not found');
  }
  const workingDir = archive.workspace.worktreePath;
  if (!workingDir) {
    throw new ApplicationError('INVALID_INPUT', 'Workspace has no worktree path');
  }
  if (
    !archive.transcriptPath ||
    isAbsolute(archive.transcriptPath) ||
    win32.isAbsolute(archive.transcriptPath)
  ) {
    throw new ApplicationError('INVALID_INPUT', 'Invalid closed session transcript path');
  }
  const root = resolve(workingDir);
  const file = resolve(root, archive.transcriptPath);
  requireContainedPath(root, file);
  const realRoot = await realpath(root);
  const realFile = await realpath(file);
  requireContainedPath(realRoot, realFile);
  return { archive, workingDir, realFile };
}

function throwReadError(error: unknown): never {
  if (error instanceof ApplicationError) {
    throw error;
  }
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    throw new ApplicationError('NOT_FOUND', 'Transcript file not found');
  }
  throw new ApplicationError('INTERNAL_ERROR', 'Failed to read transcript file');
}

/** Header identity is a lookup aid; only scoped provider history proves delivery. */
export async function readClosedSessionProviderIdentity(
  id: string
): Promise<ArchivedProviderIdentity> {
  try {
    const { archive, workingDir, realFile } = await findTranscriptFile(id);
    const header = await readClosedSessionTranscriptHeader(
      realFile,
      z.object({
        sessionId: z.literal(archive.sessionId),
        workspaceId: z.literal(archive.workspaceId).optional(),
        metadata: providerIdentitySchema.extend({ provider: z.literal(archive.provider) }),
      })
    );
    // Retain the actual worktree spelling: native provider history keys use it.
    return { ...header.metadata, workingDir };
  } catch (error) {
    throwReadError(error);
  }
}

export async function readClosedSessionTranscript(id: string) {
  try {
    const { realFile } = await findTranscriptFile(id);
    return parseClosedSessionReadTranscript(await readFile(realFile, 'utf-8'));
  } catch (error) {
    throwReadError(error);
  }
}
