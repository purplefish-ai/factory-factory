import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import { dataBackupService } from './data-backup.service';

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
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));

const timestamp = new Date('2026-11-10T10:00:00.000Z');
const identity = { sessionId: 'session', providerSessionId: 'provider-session', toolUseId: 'tool' };
const summary = {
  toolUseId: 'tool',
  status: 'answered',
  questions: [
    { id: 'regular', question: 'Choose an option', answers: ['Option B'], note: 'Explanation' },
    { id: 'secret', question: 'Enter a secret', answers: [], redacted: true },
  ],
};

beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/p',
      worktreeBasePath: '/tmp/w',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', projectId: 'project', name: 'Workspace' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: identity.sessionId,
      workspaceId: 'workspace',
      workflow: 'followup',
      provider: 'CODEX',
      providerSessionId: identity.providerSessionId,
    },
  });
  await db.prisma.sessionQuestionResponse.createMany({
    data: [
      {
        ...identity,
        timestamp,
        summary: {
          ...summary,
          rawInput: { value: 'private-input' },
          questions: [
            summary.questions[0]!,
            { ...summary.questions[1], answers: ['private-answer'], note: 'private-note' },
          ],
        },
      },
      { ...identity, providerSessionId: 'prior-provider-session', timestamp, summary },
    ],
  });
});

it('roundtrips safe summaries under their exact session and provider identities', async () => {
  const wire = JSON.stringify(await dataBackupService.exportData('test'));
  expect(wire).not.toContain('private-');
  const backup = exportDataSchema.parse(JSON.parse(wire));
  const rows = [
    { ...identity, providerSessionId: 'prior-provider-session', timestamp, summary },
    { ...identity, timestamp, summary },
  ];
  expect(backup.meta).toHaveProperty('recovery.profile', 'base-json-question-responses-1');
  expect(backup.data).toHaveProperty('recovery.questionResponses', {
    version: 1,
    responses: rows.map((row) => ({ ...row, timestamp: timestamp.toISOString() })),
  });

  await clearIntegrationDatabase(db.prisma);
  await dataBackupService.importData(backup);
  expect(
    await db.prisma.sessionQuestionResponse.findMany({ orderBy: { providerSessionId: 'asc' } })
  ).toEqual(rows);
});

it('leaves responses for occupied sessions untouched', async () => {
  const backup = await dataBackupService.exportData('test');
  await db.prisma.sessionQuestionResponse.deleteMany();
  await db.prisma.sessionQuestionResponse.create({
    data: {
      ...identity,
      timestamp,
      summary: { toolUseId: 'tool', status: 'cancelled', questions: [] },
    },
  });

  const result = await dataBackupService.importData(backup);

  expect(result.agentSessions).toEqual({ imported: 0, skipped: 1 });
  expect(await db.prisma.sessionQuestionResponse.findMany()).toEqual([
    { ...identity, timestamp, summary: { toolUseId: 'tool', status: 'cancelled', questions: [] } },
  ]);
});

it('rejects a current profile with no question response section', async () => {
  const backup = await dataBackupService.exportData('test');
  if (!('recovery' in backup.data)) {
    throw new Error('Expected a versioned recovery envelope');
  }
  Reflect.deleteProperty(backup.data.recovery, 'questionResponses');
  expect(exportDataSchema.safeParse(backup).success).toBe(false);
});

it.each([
  ['missing parent', [{ ...identity, sessionId: 'foreign', summary }]],
  ['mismatched summary', [{ ...identity, summary: { ...summary, toolUseId: 'wrong-tool' } }]],
  [
    'duplicate response identity',
    [
      { ...identity, summary },
      { ...identity, summary },
    ],
  ],
  [
    'unredacted secret',
    [
      {
        ...identity,
        summary: {
          ...summary,
          questions: [{ redacted: true, question: 'Enter a secret', answers: ['private-answer'] }],
        },
      },
    ],
  ],
  [
    'raw provider data',
    [{ ...identity, summary: { ...summary, rawInput: { value: 'private-input' } } }],
  ],
] as const)('rejects a question response with %s', async (_name, rows) => {
  const backup = await dataBackupService.exportData('test');
  if (!('recovery' in backup.data)) {
    throw new Error('Expected a versioned recovery envelope');
  }
  const invalid = {
    ...backup,
    data: {
      ...backup.data,
      recovery: {
        ...backup.data.recovery,
        questionResponses: {
          version: 1,
          responses: rows.map((row) => ({ ...row, timestamp: timestamp.toISOString() })),
        },
      },
    },
  };
  expect(exportDataSchema.safeParse(invalid).success).toBe(false);
});
