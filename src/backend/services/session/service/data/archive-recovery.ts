import { open } from 'node:fs/promises';
import {
  archiveRecoverySchema,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_TOTAL_BYTES,
  type ArchiveRecovery,
} from '@/shared/schemas/archive-recovery.schema';
import type { ClosedSession, Prisma } from '@prisma-gen/client';
import { stageSessionArchiveRecovery } from '../../resources/archive-recovery';
import { closedSessionPersistenceService } from '../lifecycle/closed-session-persistence.service';
import {
  archiveDigest,
  closedSessionArchivePath,
  resolveClosedSessionTranscriptPath,
} from '../lifecycle/closed-session-storage';

/** Bounded exact UTF-8 reads; a concurrent truncate/growth fails this export. */
async function readTranscript(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new Error('Archive file exceeds entry limit or is not a file');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
      count += bytesRead;
      if (!bytesRead || count === buffer.length) {
        break;
      }
    }
    const after = await file.stat();
    if (
      count !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('Archive changed during export');
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, count)
    );
  } finally {
    await file.close();
  }
}

function validateChecksums(recovery: ArchiveRecovery): void {
  for (const entry of recovery.entries) {
    if (archiveDigest(entry.transcript) !== entry.sha256) {
      throw new Error(`Archive checksum mismatch: ${entry.id}`);
    }
  }
}

async function snapshotTranscript(
  row: ClosedSession,
  worktreePath: string | null
): Promise<string> {
  const path = resolveClosedSessionTranscriptPath(row, worktreePath);
  if (row.archiveState !== 'PENDING') {
    return await readTranscript(path);
  }
  if (!(row.pendingTranscript && row.transcriptHash && row.archiveKey)) {
    throw new Error('Invalid pending archive proof');
  }
  return row.pendingTranscript;
}

async function exportEntry(
  row: ClosedSession,
  workspaces: ReadonlyMap<string, string | null>
): Promise<ArchiveRecovery['entries'][number]> {
  if (!workspaces.has(row.workspaceId)) {
    throw new Error('Archive workspace is absent from snapshot');
  }
  const transcript = await snapshotTranscript(row, workspaces.get(row.workspaceId) ?? null);
  const byteLength = Buffer.byteLength(transcript, 'utf8');
  if (byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
    throw new Error('Archive exceeds entry byte limit');
  }
  const sha256 = archiveDigest(transcript);
  if (
    (row.archiveKey && !row.transcriptHash) ||
    (row.transcriptHash && row.transcriptHash !== sha256)
  ) {
    throw new Error('Archive checksum mismatch');
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    name: row.name,
    workflow: row.workflow,
    provider: row.provider,
    model: row.model,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    archiveKey:
      row.archiveKey ?? archiveDigest(JSON.stringify(['legacy', row.workspaceId, row.id, sha256])),
    sha256,
    byteLength,
    transcript,
  };
}

/** Rows come from the caller's consistent snapshot; all file I/O occurs here, after it closes. */
export async function exportSessionArchives(
  rows: readonly ClosedSession[],
  workspaces: ReadonlyMap<string, string | null>
): Promise<ArchiveRecovery> {
  if (rows.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('Archive package exceeds entry count limit');
  }
  const entries: ArchiveRecovery['entries'] = [];
  let total = 0;
  for (const row of rows) {
    try {
      const entry = await exportEntry(row, workspaces);
      total += entry.byteLength;
      if (total > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new Error('Archive package exceeds total byte limit');
      }
      entries.push(entry);
    } catch (cause) {
      throw new Error(`Incomplete archive export: ${row.id}`, { cause });
    }
  }
  const recovery = archiveRecoverySchema.parse({ version: 1, entries });
  validateChecksums(recovery);
  return recovery;
}

/** Relational staging only. The caller must commit before publishing these IDs. */
export async function restoreSessionArchives(
  tx: Prisma.TransactionClient,
  recovery: ArchiveRecovery,
  importedWorkspaceIds: ReadonlySet<string>
): Promise<string[]> {
  const validated = archiveRecoverySchema.parse(recovery);
  validateChecksums(validated);
  return await stageSessionArchiveRecovery(
    tx,
    validated.entries.map((entry) => ({
      id: entry.id,
      workspaceId: entry.workspaceId,
      sessionId: entry.sessionId,
      name: entry.name,
      workflow: entry.workflow,
      provider: entry.provider,
      model: entry.model,
      startedAt: new Date(entry.startedAt),
      completedAt: new Date(entry.completedAt),
      archiveKey: entry.archiveKey,
      transcriptHash: entry.sha256,
      pendingTranscript: entry.transcript,
      transcriptPath: closedSessionArchivePath(entry.workspaceId, entry.id, entry.sha256),
    })),
    importedWorkspaceIds
  );
}

/** Failure is visible to the caller; committed pending bytes remain restart recoverable. */
export async function publishRestoredSessionArchives(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await closedSessionPersistenceService.recoverById(id);
  }
}
