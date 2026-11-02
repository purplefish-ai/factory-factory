import { randomUUID } from 'node:crypto';
import { unlinkSync, type Dir, type Dirent } from 'node:fs';
import { opendir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomic } from '@/backend/lib/atomic-file';
import { isProcessRunning } from '@/backend/lib/process-liveness';
import { createLogger } from '@/backend/services/logger.service';
import { closedSessionAccessor } from '@/backend/services/session/resources/closed-session.accessor';
import {
  archiveDigest,
  closedSessionArchivePath,
  closedSessionArchivesDirectory,
  resolveClosedSessionTranscriptPath,
  removeClosedSessionWorkspaceDirectory,
} from '@/backend/services/session/service/lifecycle/closed-session-storage';
import type { ChatMessage } from '@/shared/acp-protocol';
import type { ClosedSession } from '@prisma-gen/client';
import type { SessionProvider } from '@prisma-gen/client';

const logger = createLogger('closed-session-persistence');

export interface ClosedSessionTranscript {
  version: 1;
  sessionId: string;
  workspaceId: string;
  metadata: {
    name: string | null;
    workflow: string;
    provider: SessionProvider;
    codexAccountId?: string | null;
    providerSessionId?: string;
    model: string;
    startedAt: string; // ISO timestamp
    completedAt: string; // ISO timestamp
  };
  messages: ChatMessage[];
}

export interface PersistClosedSessionInput {
  sessionId: string;
  workspaceId: string;
  worktreePath: string;
  name: string | null;
  workflow: string;
  provider: SessionProvider;
  codexAccountId?: string | null;
  providerSessionId?: string;
  conversationEpoch?: number;
  model: string;
  startedAt: Date;
  messages: ChatMessage[];
}

class ClosedSessionPersistenceService {
  private orphanRoot: Dir | undefined;
  private orphanDirectory: { path: string; cursor: Dir } | undefined;
  private pendingCursor: string | undefined;
  private readonly activeWrites = new Map<string, number>();

  async cleanupDeletedWorkspace(workspaceId: string): Promise<void> {
    try {
      await closedSessionAccessor.cleanupDeletedWorkspace(workspaceId, () =>
        removeClosedSessionWorkspaceDirectory(workspaceId)
      );
    } catch (error) {
      logger.warn('Closed-session artifact cleanup deferred', { workspaceId, error });
    }
  }

  async persistClosedSession(input: PersistClosedSessionInput): Promise<void> {
    if (input.messages.length === 0 && !input.providerSessionId) {
      return;
    }
    // Snapshot first: callers may mutate their projection while the DB is awaited.
    // Include the full immutable snapshot so a cancelled rollover followed by later
    // activity can retain a newer copy without overwriting the earlier archive.
    const snapshot = {
      version: 1,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      metadata: {
        name: input.name,
        workflow: input.workflow,
        provider: input.provider,
        codexAccountId: input.codexAccountId ?? null,
        providerSessionId: input.providerSessionId,
        conversationEpoch: input.conversationEpoch ?? 0,
        model: input.model,
        startedAt: input.startedAt.toISOString(),
      },
      messages: input.messages,
    };
    const archiveKey = archiveDigest(JSON.stringify(snapshot));
    const completedAt = new Date();
    const pendingTranscript = JSON.stringify(
      { ...snapshot, metadata: { ...snapshot.metadata, completedAt: completedAt.toISOString() } },
      null,
      2
    );
    const id = randomUUID();
    const transcriptHash = archiveDigest(pendingTranscript);
    const row = await closedSessionAccessor.reserve({
      id,
      archiveKey,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      name: input.name,
      workflow: input.workflow,
      provider: input.provider,
      model: input.model,
      transcriptPath: closedSessionArchivePath(input.workspaceId, id, transcriptHash),
      startedAt: input.startedAt,
      completedAt,
      pendingTranscript,
      transcriptHash,
    });
    if (row.archiveState === 'COMPLETE') {
      return;
    }
    await this.finish(row);
  }

  /** Relocate all legacy copies before worktree removal; abort cleanup on failure.
   * Each reservation keeps the original bytes durably; legacy files are never unlinked.
   */
  async preserveWorkspaceArchives(workspaceId: string): Promise<void> {
    for (;;) {
      const pending = await closedSessionAccessor.findPending(workspaceId);
      if (!pending.length) {
        break;
      }
      for (const row of pending) {
        await this.finish(row);
      }
    }
    for (;;) {
      const legacy = await closedSessionAccessor.findLegacy(workspaceId);
      if (!legacy.length) {
        break;
      }
      for (const row of legacy) {
        const bytes = await readFile(
          resolveClosedSessionTranscriptPath(row, row.workspace.worktreePath),
          'utf-8'
        );
        const archiveKey = archiveDigest(
          JSON.stringify(['legacy', row.workspaceId, row.id, archiveDigest(bytes)])
        );
        const pending = await closedSessionAccessor.stageLegacy(row.id, {
          archiveKey,
          transcriptPath: closedSessionArchivePath(workspaceId, row.id, archiveDigest(bytes)),
          pendingTranscript: bytes,
          transcriptHash: archiveDigest(bytes),
        });
        if (pending.archiveState !== 'COMPLETE') {
          await this.finish(pending);
        }
      }
    }
  }

  /** On-use recovery is bounded; pending bytes survive process restart. */
  async recoverPending(workspaceId: string): Promise<void> {
    for (const row of await closedSessionAccessor.findPending(workspaceId)) {
      try {
        await this.finish(row);
      } catch (error) {
        logger.warn('Closed session recovery deferred', { id: row.id, error });
      }
    }
  }

  /** Invoked by the existing reconciliation job, never by history list reads. */
  async maintainArchives(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    const pending = await closedSessionAccessor.findMaintenancePending(this.pendingCursor);
    for (const row of pending) {
      if (signal?.aborted) {
        return;
      }
      try {
        await this.finish(row);
      } catch (error) {
        logger.warn('Closed session recovery deferred', { id: row.id, error });
      }
      this.pendingCursor = row.id;
    }
    if (!pending.length) {
      this.pendingCursor = undefined;
    }
    if (!signal?.aborted) {
      await this.collectOrphanPage(signal);
    }
  }

  async stopArchiveMaintenance(): Promise<void> {
    const directory = this.orphanDirectory;
    const root = this.orphanRoot;
    this.orphanDirectory = undefined;
    this.orphanRoot = undefined;
    await directory?.cursor.close().catch(() => undefined);
    await root?.close().catch(() => undefined);
  }

  private async nextOrphanDirectory(): Promise<{ path: string; cursor: Dir } | undefined> {
    this.orphanRoot ??= await opendir(closedSessionArchivesDirectory());
    for (let inspected = 0; inspected < 10; inspected++) {
      const entry = await this.orphanRoot.read();
      if (!entry) {
        await this.orphanRoot.close();
        this.orphanRoot = undefined;
        return undefined;
      }
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) {
        const path = join(closedSessionArchivesDirectory(), entry.name);
        return { path, cursor: await opendir(path) };
      }
    }
    return undefined;
  }

  private async collectOrphanPage(signal?: AbortSignal): Promise<void> {
    try {
      this.orphanDirectory ??= await this.nextOrphanDirectory();
      const directory = this.orphanDirectory;
      if (!directory) {
        return;
      }
      for (let inspected = 0; inspected < 100 && !signal?.aborted; inspected++) {
        const entry = await directory.cursor.read();
        if (!entry) {
          await directory.cursor.close();
          this.orphanDirectory = undefined;
          break;
        }
        await this.collectArtifact(directory.path, entry, signal);
      }
    } catch (error) {
      await this.stopArchiveMaintenance();
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        logger.warn('Archive orphan cleanup deferred', { error });
      }
    }
  }

  private async collectArtifact(
    directory: string,
    entry: Dirent,
    signal?: AbortSignal
  ): Promise<void> {
    if (!entry.isFile()) {
      return;
    }
    if (entry.name.startsWith('.tmp-archive-')) {
      await this.collectTemporaryArtifact(directory, entry.name);
      return;
    }
    const parsed = /^([a-zA-Z0-9_-]{1,128})\.([a-f0-9]{64})\.json$/.exec(entry.name);
    if (!parsed) {
      return;
    }
    const [, id, hash] = parsed;
    if (!(id && hash)) {
      return;
    }
    const transcriptPath = join('closed-sessions', basename(directory), entry.name);
    if (await closedSessionAccessor.findArtifactOwner(id, hash, transcriptPath)) {
      return;
    }
    if (signal?.aborted) {
      return;
    }
    await closedSessionAccessor
      .removeOrphan(id, hash, transcriptPath, () => unlinkSync(join(directory, entry.name)))
      .catch((error: unknown) => logger.warn('Archive artifact cleanup deferred', { error }));
  }

  private async collectTemporaryArtifact(directory: string, name: string): Promise<void> {
    const match = /^\.tmp-archive-(\d+)-[a-f0-9-]{36}$/.exec(name);
    if (!match) {
      return;
    }
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return;
    }
    if (pid === process.pid) {
      // Registered before an atomic helper can create a temporary file. A new
      // write uses a new UUID, so an observed idle candidate is never reused.
      if (this.activeWrites.has(directory)) {
        return;
      }
    } else if (await isProcessRunning(pid)) {
      return;
    }
    try {
      unlinkSync(join(directory, name));
    } catch (error) {
      logger.warn('Archive temporary cleanup deferred', { error });
    }
  }

  async deleteArchive(id: string) {
    const row = await closedSessionAccessor.findByIdWithWorkspace(id);
    const deleted = await closedSessionAccessor.delete(id);
    if (row) {
      try {
        const path = resolveClosedSessionTranscriptPath(row, row.workspace.worktreePath);
        if (row.archiveKey && row.transcriptHash) {
          await closedSessionAccessor.removeOrphan(
            row.id,
            row.transcriptHash,
            row.transcriptPath,
            () => unlinkSync(path)
          );
        } else {
          unlinkSync(path);
        }
      } catch (error) {
        logger.warn('Archive artifact cleanup deferred', { id, error });
      }
    }
    return deleted;
  }

  async recoverById(id: string): Promise<void> {
    const row = await closedSessionAccessor.findPendingById(id);
    if (row) {
      await this.finish(row);
    }
  }

  private async finish(row: ClosedSession): Promise<void> {
    if (
      !(row.pendingTranscript && row.transcriptHash) ||
      archiveDigest(row.pendingTranscript) !== row.transcriptHash
    ) {
      throw new Error('Invalid pending archive proof');
    }
    const path = resolveClosedSessionTranscriptPath(row, null);
    const pendingTranscript = row.pendingTranscript;
    const directory = dirname(path);
    this.activeWrites.set(directory, (this.activeWrites.get(directory) ?? 0) + 1);
    try {
      // The row ID and exact digest name this immutable artifact generation.
      // A re-reserved logical key gets another ID/path, so late writers cannot
      // overwrite replacements. Filesystem awaits never hold a DB transaction.
      await writeFileAtomic(path, pendingTranscript, {
        encoding: 'utf-8',
        mode: 0o600,
        temporaryFileTag: `archive-${process.pid}`,
      });
      if (archiveDigest(await readFile(path, 'utf-8')) !== row.transcriptHash) {
        throw new Error('Archive verification failed');
      }
      await closedSessionAccessor.complete(row.id, row.transcriptHash);
    } catch (error) {
      await closedSessionAccessor
        .removeOrphan(row.id, row.transcriptHash, row.transcriptPath, () => unlinkSync(path))
        .catch(() => undefined);
      throw error;
    } finally {
      const remaining = (this.activeWrites.get(directory) ?? 1) - 1;
      if (remaining > 0) {
        this.activeWrites.set(directory, remaining);
      } else {
        this.activeWrites.delete(directory);
      }
    }
  }
}

export const closedSessionPersistenceService = new ClosedSessionPersistenceService();
