import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  archiveRecoveryInventoryDescriptor,
  sessionRecoveryInventoryDescriptor,
  durableRecoveryInventoryDescriptors,
  prRecoveryInventoryDescriptors,
  readRecoveryInventory,
  reportRecoveryImport,
  validateRecoveryIdentityUniqueness,
} from '@/backend/services/settings/resources/recovery-inventory';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { durableRecoverySchema } from '@/shared/schemas/durable-recovery.schema';
import type { ExportData } from '@/shared/schemas/export-data.schema';
import { Prisma } from '@prisma-gen/client';

type Descriptor = {
  model: string;
  table: string;
  identity: 'primary' | 'unique';
  keys: readonly { field: string; column: string }[];
};
const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
function metadata(source = schema) {
  return new Map(
    Array.from(source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm), ([, name, body = '']) => {
      const compound = /@@id\s*\(\s*\[([^\]]+)\]/.exec(body)?.[1];
      const primary = compound
        ? compound.split(',').map((field) => field.trim())
        : Array.from(body.matchAll(/^\s*(\w+)\s+[^\n]*\s@id\b/gm), (match) => match[1]);
      const keys = primary.map((field) => {
        const line = body.split('\n').find((entry) => entry.trim().startsWith(`${field} `));
        return { field, column: line?.match(/@map\("([^"]+)"\)/)?.[1] ?? field };
      });
      const uniques = Array.from(body.matchAll(/@@unique\s*\(\s*\[([^\]]+)\]/g), (match) =>
        match[1]!.split(',').map((item) => {
          const field = item.trim();
          const line = body.split('\n').find((entry) => entry.trim().startsWith(`${field} `));
          return { field, column: line?.match(/@map\("([^"]+)"\)/)?.[1] ?? field };
        })
      );
      return [name, { table: body.match(/@@map\("([^"]+)"\)/)?.[1] ?? name, keys, uniques }];
    })
  );
}
const allDescriptors = () => ({
  ...durableRecoveryInventoryDescriptors,
  closedSession: archiveRecoveryInventoryDescriptor,
  agentSession: sessionRecoveryInventoryDescriptor,
  ...prRecoveryInventoryDescriptors,
});
function verifyCoverage(descriptors: Record<string, Descriptor>, models = metadata()) {
  const expectedKeys = [
    ...Object.keys(durableRecoverySchema.shape).filter((key) => key !== 'jsonStorage'),
    'closedSession',
    'agentSession',
    'workspacePR',
    'workspacePRDedicatedSession',
    'workspacePRDelivery',
    'workspacePREvent',
  ];
  expect(Object.keys(descriptors).sort(), 'Inventory group coverage mismatch').toEqual(
    expectedKeys.sort()
  );
  expect(
    new Set(Object.values(descriptors).map((entry) => entry.model)).size,
    'Inventory model coverage mismatch'
  ).toBe(expectedKeys.length);
  for (const entry of Object.values(descriptors)) {
    expect(Object.values(Prisma.ModelName)).toContain(entry.model);
    const model = models.get(entry.model);
    expect(model).toBeDefined();
    expect(entry.table, `Inventory table mismatch: ${entry.model}`).toBe(model?.table);
    if (entry.identity === 'unique') {
      expect(model?.uniques, `Inventory unique key mismatch: ${entry.model}`).toContainEqual(
        entry.keys
      );
    } else {
      expect(entry.keys, `Inventory primary key mismatch: ${entry.model}`).toEqual(model?.keys);
    }
  }
}

it('exhaustively maps every durable array and archive to independent Prisma table/ordered primary/unique-key metadata', () => {
  verifyCoverage(allDescriptors());
});
it('detects omitted mappings, wrong models/tables, nonprimary fields and SQL-column drift', () => {
  const descriptors = allDescriptors();
  expect(() =>
    verifyCoverage(
      Object.fromEntries(Object.entries(descriptors).filter(([key]) => key !== 'agentSourceHead'))
    )
  ).toThrow('Inventory group coverage mismatch');
  expect(() =>
    verifyCoverage({ ...descriptors, agentRun: { ...descriptors.agentRun, model: 'AgentEvent' } })
  ).toThrow('Inventory model coverage mismatch');
  expect(() =>
    verifyCoverage({
      ...descriptors,
      workspaceNotification: {
        ...descriptors.workspaceNotification,
        table: 'WorkspaceNotification',
      },
    })
  ).toThrow('Inventory table mismatch: WorkspaceNotification');
  expect(() =>
    verifyCoverage({
      ...descriptors,
      agentSourceCheckpoint: {
        ...descriptors.agentSourceCheckpoint,
        keys: [{ field: 'scanId', column: 'scanId' }],
      },
    })
  ).toThrow('Inventory primary key mismatch: AgentSourceCheckpoint');
  expect(() =>
    verifyCoverage({
      ...descriptors,
      chatIntent: { ...descriptors.chatIntent, keys: [{ field: 'createdAt', column: 'id' }] },
    })
  ).toThrow('Inventory unique key mismatch: ChatIntent');
  expect(() =>
    verifyCoverage({
      ...descriptors,
      agentSourceState: {
        ...descriptors.agentSourceState,
        keys: [{ field: 'connectionId', column: 'connection_id' }],
      },
    })
  ).toThrow('Inventory primary key mismatch: AgentSourceState');
});
it('does not turn an unrelated new nullable field into an inventory contract change', () => {
  const extended = schema.replace(
    'model AgentRun {',
    'model AgentRun {\n  futureNullablePreference String?'
  );
  verifyCoverage(allDescriptors(), metadata(extended));
});

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  vi.stubEnv('BASE_DIR', db.tempDir);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
  vi.unstubAllEnvs();
});
const emptyDurable = () =>
  durableRecoverySchema.parse(
    Object.fromEntries(
      Object.keys(durableRecoverySchema.shape).map((key) => [
        key,
        key === 'jsonStorage' ? { version: 1, jsonNulls: [] } : [],
      ])
    )
  );

it('resolves every registered table and ordered primary/unique key against a real migrated SQLite database', async () => {
  const rowSchema = z.array(
    z.object({
      name: z.string(),
      pk: z.union([z.number().int().nonnegative(), z.bigint().nonnegative()]).transform(Number),
    })
  );
  for (const entry of Object.values(allDescriptors())) {
    const rows = rowSchema.parse(
      await db.prisma.$queryRaw(Prisma.sql`PRAGMA table_info(${Prisma.raw(`"${entry.table}"`)})`)
    );
    if (entry.identity === 'unique') {
      const indexes = z
        .array(
          z.object({
            name: z.string(),
            unique: z.union([z.number(), z.bigint()]).transform(Number),
          })
        )
        .parse(
          await db.prisma.$queryRaw(
            Prisma.sql`PRAGMA index_list(${Prisma.raw(`"${entry.table}"`)})`
          )
        );
      const indexedColumns: string[][] = [];
      for (const index of indexes.filter((row) => row.unique === 1)) {
        const columns = z
          .array(
            z.object({
              name: z.string(),
              seqno: z.union([z.number(), z.bigint()]).transform(Number),
            })
          )
          .parse(
            await db.prisma.$queryRaw(
              Prisma.sql`PRAGMA index_info(${Prisma.raw(`"${index.name}"`)})`
            )
          );
        indexedColumns.push(columns.sort((a, b) => a.seqno - b.seqno).map((row) => row.name));
      }
      expect(indexedColumns).toContainEqual(entry.keys.map((key) => key.column));
    } else {
      expect(
        rows
          .filter((row) => row.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((row) => row.name)
      ).toEqual(entry.keys.map((key) => key.column));
    }
  }
});
it('preserves natural, mapped-table and compound JSON identities, 200-row batching and collision reasons', async () => {
  const project = await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Inventory',
      slug: 'inventory',
      repoPath: '/repo',
      worktreeBasePath: '/trees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', projectId: project.id, name: 'Inventory' },
  });
  await db.prisma.agentSession.create({
    data: { id: 'session', workspaceId: 'workspace', workflow: 'default', provider: 'CLAUDE' },
  });
  const settings = {
    selectedModel: null,
    reasoningEffort: null,
    thinkingEnabled: false,
    planModeEnabled: false,
  };
  await db.prisma.chatIntent.create({
    data: {
      id: 17,
      sessionId: 'session',
      messageId: 'human',
      fingerprint: 'original',
      submitted: { id: 'human', text: 'Original', timestamp: '2026-01-01', settings },
      desired: settings,
    },
  });
  await db.prisma.agentConnection.create({
    data: { id: 'connection', name: 'source', provider: 'GITHUB', externalId: 'inventory' },
  });
  await db.prisma.agentSourceState.create({ data: { connectionId: 'connection' } });
  await db.prisma.agentSourceCheckpoint.create({
    data: { connectionId: 'connection', scanId: 'scan"\\unicode😀', status: 'BUILDING' },
  });
  await db.prisma.workspaceNotification.create({
    data: {
      id: 'notification',
      workspaceId: 'workspace',
      sourceWorkspaceId: 'deleted',
      sourceWorkspaceName: 'source',
      sourceProjectName: 'source',
      message: 'retained',
      direction: 'CHILD_TO_PARENT',
    },
  });
  await db.prisma.decisionLog.createMany({
    data: Array.from({ length: 201 }, (_, index) => ({
      id: `decision-${index}`,
      agentId: 'deleted',
      decision: 'kept',
      reasoning: 'history',
    })),
  });
  const data: ExportData['data'] = {
    projects: [],
    workspaces: [],
    agentSessions: [],
    terminalSessions: [],
    userSettings: null,
    codexAccounts: [],
    durable: {
      ...emptyDurable(),
      chatIntent: [],
      agentSourceCheckpoint: [],
      workspaceNotification: [],
      decisionLog: [],
    },
  };
  const durable = data.durable;
  if (!durable) {
    throw new Error('Missing durable fixture');
  }
  durable.chatIntent = [
    {
      id: 17,
      sessionId: 'session',
      messageId: 'human',
      fingerprint: 'original',
      submitted: { id: 'human', text: 'Original', timestamp: '2026-01-01', settings },
      desired: settings,
      revision: 0,
      status: 'queued',
      attemptId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  durable.agentSourceCheckpoint = [
    {
      connectionId: 'connection',
      scanId: 'scan"\\unicode😀',
      status: 'BUILDING',
      nextOrdinal: 0,
      entryCount: 0,
      executableCount: 0,
      verifiedCount: 0,
      verification: null,
      headEventId: null,
      boundaryKnown: false,
      previousBoundaryEventId: null,
      initialSourceOrder: null,
      sourceOrder: null,
      validationCursor: null,
    },
  ];
  durable.workspaceNotification = [
    {
      id: 'notification',
      recoveryHeld: false,
      workspaceId: 'workspace',
      sourceWorkspaceId: 'deleted',
      sourceWorkspaceName: 'source',
      sourceProjectName: 'source',
      message: 'retained',
      direction: 'CHILD_TO_PARENT',
      deliveredAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  durable.decisionLog = Array.from({ length: 203 }, (_, index) => ({
    id: `decision-${index}`,
    agentId: 'deleted',
    decision: 'kept',
    reasoning: 'history',
    context: null,
    timestamp: '2026-01-01T00:00:00.000Z',
  }));
  const query = vi.spyOn(db.prisma, '$queryRaw');
  const before = await readRecoveryInventory(db.prisma, data);
  expect(before.get('ChatIntent')).toEqual(new Set(['["session","human"]']));
  expect(before.get('WorkspaceNotification')).toEqual(new Set(['["notification"]']));
  expect(before.get('AgentSourceCheckpoint')).toEqual(
    new Set([JSON.stringify(['connection', 'scan"\\unicode😀'])])
  );
  expect(before.get('DecisionLog')?.size).toBe(201);
  expect(query).toHaveBeenCalledTimes(5); // Three identity shapes plus two <=200-row decision batches.
  query.mockRestore();
  await db.prisma.decisionLog.deleteMany({ where: { id: 'decision-0' } });
  await db.prisma.decisionLog.create({
    data: { id: 'decision-201', agentId: 'deleted', decision: 'kept', reasoning: 'history' },
  });
  const report = await reportRecoveryImport(db.prisma, data, before);
  expect(report.models).toContainEqual({ model: 'DecisionLog', imported: 1, skipped: 202 });
  expect(report.skipped).toContainEqual({
    model: 'DecisionLog',
    identity: 'decision-0',
    reason: 'EXISTING_IDENTITY',
  });
  expect(report.skipped).toContainEqual({
    model: 'DecisionLog',
    identity: 'decision-202',
    reason: 'CONFLICTING_IDENTITY_OR_PARENT',
  });
  expect(report.skipped).toContainEqual({
    model: 'ChatIntent',
    identity: '["session","human"]',
    reason: 'EXISTING_IDENTITY',
  });
  durable.chatIntent.push(durable.chatIntent[0]!);
  expect(() => validateRecoveryIdentityUniqueness(data)).toThrow(
    'Duplicate recovery identity ChatIntent: ["session","human"]'
  );
});
