import { stat } from 'node:fs/promises';
import type { HistoryMessage } from '@/shared/acp-protocol';

/** A provider history file as `stat` saw it. Any changed field means the content may differ. */
export interface HistoryFileIdentity {
  filePath: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

/**
 * Optional loader hook. Given the resolved file's identity before it is read,
 * return a value already derived from exactly that file to skip the read.
 */
export type HistoryFileReuse<T> = (file: HistoryFileIdentity) => T | undefined;

export type LoadedHistoryFile = {
  status: 'loaded';
  history: HistoryMessage[];
  filePath: string;
  /** Present only with `reuse`, when the file was unchanged across the read. */
  file?: HistoryFileIdentity;
};
export type FailedHistoryFile = { status: 'error'; reason: 'read_failed'; filePath: string };
/** Shared by the Claude and Codex loaders. */
export type HistoryLoadResult =
  | LoadedHistoryFile
  | { status: 'not_found' }
  | { status: 'skipped'; reason: 'missing_provider_session_id' | 'invalid_provider_session_id' }
  | FailedHistoryFile;
export type ReusedHistoryFile<T> = { status: 'reused'; value: T; filePath: string };

export function isSameHistoryFile(left: HistoryFileIdentity, right: HistoryFileIdentity): boolean {
  return (
    left.filePath === right.filePath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ino === right.ino
  );
}

async function statHistoryFile(filePath: string): Promise<HistoryFileIdentity | null> {
  try {
    const stats = await stat(filePath);
    return stats.isFile()
      ? { filePath, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino }
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads a resolved history file. Without `reuse` this only reads. With it, the
 * caller is offered the file identity first, and the identity is reported with
 * the history only when the file was unchanged across the read, so a caller
 * never keys data to a file that changed while it was being parsed.
 */
export async function loadHistoryFile<T>(params: {
  filePath: string;
  reuse: HistoryFileReuse<T> | undefined;
  read: () => Promise<{ history: HistoryMessage[]; hadReadError: boolean }>;
}): Promise<LoadedHistoryFile | FailedHistoryFile | ReusedHistoryFile<T>> {
  const { filePath, reuse } = params;
  const before = reuse ? await statHistoryFile(filePath) : null;
  const reused = before && reuse ? reuse(before) : undefined;
  if (reused !== undefined) {
    return { status: 'reused', value: reused, filePath };
  }
  const { history, hadReadError } = await params.read();
  if (hadReadError) {
    return { status: 'error', reason: 'read_failed', filePath };
  }
  const after = before ? await statHistoryFile(filePath) : null;
  return before && after && isSameHistoryFile(before, after)
    ? { status: 'loaded', history, filePath, file: before }
    : { status: 'loaded', history, filePath };
}
