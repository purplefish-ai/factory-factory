import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import { stageSessionArchiveRecovery } from '@/backend/services/session/resources/archive-recovery';
import { getClosedSessionArchiveKey } from '@/backend/services/session/service/lifecycle/closed-session-identity';
import { closedSessionPersistenceService } from '@/backend/services/session/service/lifecycle/closed-session-persistence.service';
import {
  archiveDigest,
  closedSessionArchivePath,
  resolveClosedSessionTranscriptPath,
} from '@/backend/services/session/service/lifecycle/closed-session-storage';
import { archiveRecoverySchema } from '@/shared/schemas/archive-recovery.schema';
import type { ClosedSession, Prisma } from '@prisma-gen/client';
import {
  exportSessionArchives,
  publishRestoredSessionArchives,
  restoreSessionArchives,
} from './archive-recovery';

vi.mock('@/backend/services/session/resources/archive-recovery', () => ({
  stageSessionArchiveRecovery: vi.fn(),
}));
vi.mock('@/backend/services/session/service/lifecycle/closed-session-persistence.service', () => ({
  closedSessionPersistenceService: { recoverById: vi.fn() },
}));
let directory: string;
const workspaces = new Map([['workspace', null]]);
function row(overrides: Partial<ClosedSession> = {}): ClosedSession {
  const startedAt = new Date('2026-01-01');
  const completedAt = new Date('2026-01-02');
  const transcript = JSON.stringify(
    {
      version: 1,
      sessionId: 'session',
      workspaceId: 'workspace',
      metadata: {
        name: null,
        workflow: 'ratchet',
        provider: 'CODEX',
        model: 'model',
        codexAccountId: 'original-account',
        providerSessionId: 'original-native',
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
      messages: [],
    },
    null,
    2
  );
  const transcriptHash = archiveDigest(transcript);
  return {
    id: 'archive',
    workspaceId: 'workspace',
    sessionId: 'session',
    name: null,
    workflow: 'ratchet',
    provider: 'CODEX',
    model: 'model',
    startedAt,
    completedAt,
    archiveKey: getClosedSessionArchiveKey({
      workspaceId: 'workspace',
      sessionId: 'session',
      provider: 'CODEX',
      providerSessionId: 'original-native',
      codexAccountId: 'original-account',
      startedAt,
      messages: [],
    }),
    archiveState: 'PENDING',
    transcriptPath: closedSessionArchivePath('workspace', 'archive', transcriptHash),
    transcriptHash,
    pendingTranscript: transcript,
    ...overrides,
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ff-archive-helper-'));
  vi.spyOn(configService, 'getBaseDir').mockReturnValue(directory);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('archive recovery export', () => {
  it('exports durable pending bytes with original account identity without file reads', async () => {
    const source = row();
    const result = await exportSessionArchives([source], workspaces);
    expect(result.entries[0]?.transcript).toBe(source.pendingTranscript);
    expect(result.entries[0]?.transcript).toContain('original-account');
    expect(result.entries[0]).not.toHaveProperty('transcriptPath');
  });
  it.each(['missing', 'tampered'])(
    'exports exact retained COMPLETE database bytes when the file cache is %s',
    async (cache) => {
      const source = row({ archiveState: 'COMPLETE' });
      if (cache === 'tampered') {
        const path = resolveClosedSessionTranscriptPath(source, null);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '{}');
      }
      const result = await exportSessionArchives([source], workspaces);
      expect(result.entries[0]?.transcript).toBe(source.pendingTranscript);
      expect(result.entries[0]?.sha256).toBe(source.transcriptHash);
    }
  );
  it('rejects inconsistent COMPLETE database proof instead of silently substituting a file cache', async () => {
    const source = row({ archiveState: 'COMPLETE' });
    const path = resolveClosedSessionTranscriptPath(source, null);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source.pendingTranscript!);
    await expect(
      exportSessionArchives([{ ...source, pendingTranscript: '{}' }], workspaces)
    ).rejects.toThrow('Incomplete archive export');
  });
  it('reads owned completed archives after their worktree is removed', async () => {
    const source = row({ archiveState: 'COMPLETE' });
    const path = resolveClosedSessionTranscriptPath(source, null);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source.pendingTranscript!);
    const result = await exportSessionArchives(
      [{ ...source, pendingTranscript: null }],
      workspaces
    );
    expect(result.entries[0]?.sha256).toBe(source.transcriptHash);
  });
  it('derives the same stable legacy identity as worktree preservation', async () => {
    const source = row({
      archiveKey: null,
      archiveState: 'COMPLETE',
      transcriptPath: 'legacy.json',
      transcriptHash: null,
    });
    await writeFile(join(directory, 'legacy.json'), source.pendingTranscript!);
    const result = await exportSessionArchives(
      [{ ...source, pendingTranscript: null }],
      new Map([['workspace', directory]])
    );
    expect(result.entries[0]?.archiveKey).toBe(
      archiveDigest(
        JSON.stringify([
          'legacy',
          source.workspaceId,
          source.id,
          archiveDigest(source.pendingTranscript!),
        ])
      )
    );
  });
  it.each(['missing', 'tampered', 'invalid UTF8', 'BOM'])(
    'fails explicitly for %s completed bytes',
    async (kind) => {
      const source = row({ archiveState: 'COMPLETE', pendingTranscript: null });
      const path = resolveClosedSessionTranscriptPath(source, null);
      await mkdir(dirname(path), { recursive: true });
      if (kind !== 'missing') {
        await writeFile(
          path,
          kind === 'tampered' ? '{}' : kind === 'BOM' ? '\ufeff{}' : Buffer.from([0xff])
        );
      }
      await expect(exportSessionArchives([source], workspaces)).rejects.toThrow();
    }
  );
  it.each([
    { pendingTranscript: null },
    { transcriptHash: 'b'.repeat(64) },
    { transcriptPath: '../escape' },
  ])('rejects invalid pending proof/path %j', async (overrides) => {
    await expect(exportSessionArchives([row(overrides)], workspaces)).rejects.toThrow();
  });
  it('fails if a supplied snapshot has no owning workspace', async () => {
    await expect(exportSessionArchives([row()], new Map())).rejects.toThrow();
  });
});

describe('archive recovery restore', () => {
  const tx = {} as Prisma.TransactionClient;
  it('stages exact bytes in the caller transaction and excludes nonimported parents', async () => {
    const recovery = await exportSessionArchives([row()], workspaces);
    vi.mocked(stageSessionArchiveRecovery).mockResolvedValueOnce(['archive']);
    expect(await restoreSessionArchives(tx, recovery, new Set(['workspace']))).toEqual(['archive']);
    expect(stageSessionArchiveRecovery).toHaveBeenCalledWith(
      tx,
      [
        expect.objectContaining({
          id: 'archive',
          pendingTranscript: recovery.entries[0]!.transcript,
          transcriptHash: recovery.entries[0]!.sha256,
          transcriptPath: closedSessionArchivePath(
            'workspace',
            'archive',
            recovery.entries[0]!.sha256
          ),
        }),
      ],
      new Set(['workspace'])
    );
    expect(closedSessionPersistenceService.recoverById).not.toHaveBeenCalled();
  });
  it('rechecks hashes before touching relational rows', async () => {
    const recovery = await exportSessionArchives([row()], workspaces);
    recovery.entries[0]!.sha256 = 'b'.repeat(64);
    expect(archiveRecoverySchema.safeParse(recovery).success).toBe(true);
    await expect(restoreSessionArchives(tx, recovery, new Set(['workspace']))).rejects.toThrow(
      'checksum'
    );
    expect(stageSessionArchiveRecovery).not.toHaveBeenCalled();
  });
  it('requires deterministic legacy identity rather than allowing a marker to loosen modern clocks', async () => {
    const recovery = await exportSessionArchives([row()], workspaces);
    const entry = recovery.entries[0]!;
    entry.identity = 'legacy-v1';
    entry.completedAt = '2026-01-02T00:00:00.009Z';
    await expect(restoreSessionArchives(tx, recovery, new Set(['workspace']))).rejects.toThrow(
      'Invalid legacy archive identity'
    );
    expect(stageSessionArchiveRecovery).not.toHaveBeenCalled();
  });

  it('propagates interrupted publication and permits a retry of the same durable ids', async () => {
    vi.mocked(closedSessionPersistenceService.recoverById)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    await expect(publishRestoredSessionArchives(['archive'])).rejects.toThrow('disk full');
    await publishRestoredSessionArchives(['archive']);
    expect(closedSessionPersistenceService.recoverById).toHaveBeenCalledTimes(2);
  });
});
