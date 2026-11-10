import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceArchivedBlobsAccessor } from '@/backend/services/workspace/resources/workspace-archived-blobs.accessor';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { Prisma, type PrismaClient } from '@prisma-gen/client';
import {
  ARCHIVED_WORKSPACE_BLOB_RETENTION,
  archivedWorkspaceBlobRetentionService,
} from './archived-workspace-blob-retention.service';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test database');
    }
    return database.prisma;
  },
}));

let db: IntegrationDatabase;
const UPDATED_AT = new Date('2026-01-01T00:00:00.000Z');
const TAIL = ARCHIVED_WORKSPACE_BLOB_RETENTION.initOutputTailChars;
const attachment = { id: 'a1', name: 'shot.png', type: 'image/png', size: 4, data: 'iVBORw0K' };
const metadata = {
  initialPrompt: 'Fix the login race',
  startupModePreset: 'plan',
  initialAttachments: [attachment],
};
const keptMetadata = { initialPrompt: 'Fix the login race', startupModePreset: 'plan' };
const longLog = `${'early line\n'.repeat(1000)}final error: exit 1\n`;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
beforeEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
});

function createWorkspace(
  id: string,
  data: Partial<Prisma.WorkspaceUncheckedCreateInput> = {}
): Promise<unknown> {
  return db.prisma.workspace.create({
    data: {
      id,
      projectId: 'project',
      name: id,
      status: 'ARCHIVED',
      creationMetadata: metadata,
      initOutput: longLog,
      updatedAt: UPDATED_AT,
      ...data,
    },
  });
}

async function storage(id: string) {
  const [row] = await db.prisma.$queryRaw<
    Array<{ kind: string; metadata: string | null; initOutput: string | null; updatedAt: unknown }>
  >`SELECT typeof("creationMetadata") AS kind, CAST("creationMetadata" AS TEXT) AS metadata,
      "initOutput", "updatedAt" FROM "Workspace" WHERE "id" = ${id}`;
  return row;
}

async function read(id: string) {
  return await db.prisma.workspace.findUniqueOrThrow({
    where: { id },
    select: { creationMetadata: true, initOutput: true, updatedAt: true },
  });
}

describe('release after archive', () => {
  it('removes only the attachments key and drops the log of a successful setup', async () => {
    await createWorkspace('archived');
    const before = await storage('archived');
    expect(before?.kind).toBe('text');

    await archivedWorkspaceBlobRetentionService.releaseAfterArchive('archived');

    expect(await read('archived')).toEqual({
      creationMetadata: keptMetadata,
      initOutput: null,
      updatedAt: UPDATED_AT,
    });
    expect((await storage('archived'))?.kind).toBe('text');
  });

  it('keeps a marked tail of a failed setup log', async () => {
    await createWorkspace('failed', { initErrorMessage: 'Startup script failed' });

    await archivedWorkspaceBlobRetentionService.releaseAfterArchive('failed');

    const { initOutput } = await read('failed');
    expect(initOutput).toHaveLength(TAIL);
    expect(initOutput?.startsWith('[...truncated...]\n')).toBe(true);
    expect(longLog.endsWith(initOutput!.slice('[...truncated...]\n'.length))).toBe(true);
    expect(initOutput?.endsWith('final error: exit 1\n')).toBe(true);
  });

  it('keeps a short failed setup log whole', async () => {
    await createWorkspace('short', { initErrorMessage: 'warned', initOutput: 'npm WARN\n' });

    await archivedWorkspaceBlobRetentionService.releaseAfterArchive('short');

    expect((await read('short')).initOutput).toBe('npm WARN\n');
  });

  it.each(['READY', 'FAILED', 'ARCHIVING'] as const)(
    'never touches a %s workspace',
    async (status) => {
      await createWorkspace('live', { status });
      const before = await storage('live');

      await archivedWorkspaceBlobRetentionService.releaseAfterArchive('live');

      expect(await storage('live')).toEqual(before);
      expect((await read('live')).creationMetadata).toEqual(metadata);
    }
  );

  it('keeps SQL NULL, JSON null, non-object and malformed metadata as they are', async () => {
    await createWorkspace('sql-null', { creationMetadata: Prisma.DbNull });
    await createWorkspace('json-null', { creationMetadata: Prisma.JsonNull });
    await createWorkspace('array', { creationMetadata: [{ initialAttachments: [] }] });
    await createWorkspace('text', { creationMetadata: 'initialAttachments' });
    await createWorkspace('malformed', { creationMetadata: Prisma.DbNull });
    await db.prisma
      .$executeRaw`UPDATE "Workspace" SET "creationMetadata" = '{"initialAttachments":' WHERE "id" = 'malformed'`;
    const ids = ['sql-null', 'json-null', 'array', 'text', 'malformed'];
    const before = await Promise.all(ids.map(async (id) => (await storage(id))?.metadata));

    const result = await archivedWorkspaceBlobRetentionService.releaseBacklog();

    expect(result).toEqual({ released: 5, batches: 1, complete: true });
    expect(await Promise.all(ids.map(async (id) => (await storage(id))?.metadata))).toEqual(before);
    expect((await storage('sql-null'))?.kind).toBe('null');
    expect(await Promise.all(ids.map(async (id) => (await storage(id))?.initOutput))).toEqual(
      ids.map(() => null)
    );
  });

  it('rejects a tail no longer than the truncation marker before running any statement', async () => {
    await createWorkspace('failed', { initErrorMessage: 'Startup script failed' });
    const before = await storage('failed');

    for (const tailChars of [0, '[...truncated...]\n'.length, 100.5]) {
      await expect(workspaceArchivedBlobsAccessor.releaseOne('failed', tailChars)).rejects.toThrow(
        RangeError
      );
      await expect(
        workspaceArchivedBlobsAccessor.releaseBatch({ afterId: '', limit: 10, tailChars })
      ).rejects.toThrow(RangeError);
    }
    expect(await storage('failed')).toEqual(before);
  });

  it('removes an attachments key whose value is null', async () => {
    await createWorkspace('null-key', {
      creationMetadata: { initialPrompt: 'p', initialAttachments: null },
      initOutput: null,
    });

    await archivedWorkspaceBlobRetentionService.releaseAfterArchive('null-key');

    expect((await read('null-key')).creationMetadata).toEqual({ initialPrompt: 'p' });
  });
});

describe('backlog release', () => {
  it('drains in bounded batches and becomes a no-op', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await createWorkspace(id);
    }
    await createWorkspace('done', { creationMetadata: keptMetadata, initOutput: null });
    await createWorkspace('ready', { status: 'READY' });

    expect(
      await archivedWorkspaceBlobRetentionService.releaseBacklog({ batchSize: 2, maxBatches: 2 })
    ).toEqual({ released: 4, batches: 2, complete: false });
    expect(
      await archivedWorkspaceBlobRetentionService.releaseBacklog({ batchSize: 2, maxBatches: 2 })
    ).toEqual({ released: 1, batches: 1, complete: true });
    expect(
      await archivedWorkspaceBlobRetentionService.releaseBacklog({ batchSize: 2, maxBatches: 2 })
    ).toEqual({ released: 0, batches: 1, complete: true });

    for (const id of ['a', 'b', 'c', 'd', 'e', 'done']) {
      expect(await read(id)).toEqual({
        creationMetadata: keptMetadata,
        initOutput: null,
        updatedAt: UPDATED_AT,
      });
    }
    expect((await read('ready')).creationMetadata).toEqual(metadata);
  });

  it('leaves a released failed-setup tail alone on later runs', async () => {
    await createWorkspace('failed', { initErrorMessage: 'Startup script failed' });

    await archivedWorkspaceBlobRetentionService.releaseBacklog();
    const tail = (await read('failed')).initOutput;

    expect(await archivedWorkspaceBlobRetentionService.releaseBacklog()).toEqual({
      released: 0,
      batches: 1,
      complete: true,
    });
    expect((await read('failed')).initOutput).toBe(tail);
  });

  it('stops before the next batch once aborted', async () => {
    for (const id of ['a', 'b', 'c']) {
      await createWorkspace(id);
    }
    const controller = new AbortController();
    controller.abort();

    expect(
      await archivedWorkspaceBlobRetentionService.releaseBacklog({
        batchSize: 1,
        signal: controller.signal,
      })
    ).toEqual({ released: 0, batches: 0, complete: false });
    expect((await read('a')).creationMetadata).toEqual(metadata);
  });
});
