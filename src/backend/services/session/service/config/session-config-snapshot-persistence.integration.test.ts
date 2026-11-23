import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { SessionRepository } from '@/backend/services/session/service/data/session.repository';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
import { SessionConfigSnapshotPersistence } from './session-config-snapshot-persistence';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));

let db: IntegrationDatabase;
const persistence = new SessionConfigSnapshotPersistence(new SessionRepository());

beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await db.prisma.workspace.create({ data: { id: 'w', name: 'W', projectId: 'p' } });
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function observation(model: string) {
  const configOptions: SessionConfigOption[] = [
    {
      category: 'model',
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: ['first', 'second'].map((value) => ({ name: value, value })),
    },
  ];
  return { provider: 'CODEX' as const, providerSessionId: 'thread', configOptions };
}

async function fixture() {
  const session = await db.prisma.agentSession.create({
    data: {
      workspaceId: 'w',
      workflow: 'default',
      provider: 'CODEX',
      providerSessionId: 'thread',
      model: 'first',
      providerMetadata: { legacy: 'retained', providerIdentityRollovers: ['audit'] },
    },
  });
  await persistence.persist(session.id, observation('first'));
  return db.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } });
}

async function captureSql(write: () => Promise<void>) {
  const prepare = vi.spyOn(Database.prototype, 'prepare');
  try {
    await write();
    return prepare.mock.calls.map(([sql]) => sql);
  } finally {
    prepare.mockRestore();
  }
}

it('checks a repeated warm snapshot with a single session read and preserves its capture time', async () => {
  const session = await fixture();
  const sql = await captureSql(() => persistence.persist(session.id, observation('first')));
  expect(sql).toEqual([expect.stringMatching(/^SELECT .*AgentSession/i)]);
  expect(sql[0]).not.toMatch(/workspaceId|workflow|JOIN/i);
  expect(await db.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(
    session
  );
});

it('writes a changed model and its snapshot with one guarded update and one session read', async () => {
  const session = await fixture();
  const sql = await captureSql(() => persistence.persist(session.id, observation('second')));
  expect(sql.filter((query) => query.startsWith('SELECT'))).toEqual([
    expect.stringMatching(/AgentSession/),
  ]);
  expect(sql.filter((query) => query.startsWith('UPDATE'))).toEqual([
    expect.stringMatching(/WHERE .*providerSessionId.*updatedAt.*providerMetadata/i),
  ]);
  expect(
    await db.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } })
  ).toMatchObject({
    model: 'second',
    providerMetadata: {
      legacy: 'retained',
      providerIdentityRollovers: ['audit'],
      observedModelId: 'second',
      acpConfigSnapshot: { ...observation('second'), observedModelId: 'second' },
    },
  });
});

it('rejects the old snapshot when identity rolls over between the read and guarded write', async () => {
  const session = await fixture();
  const metadata = { providerIdentityRollovers: ['audit', 'rollover'] };
  const update = agentSessionAccessor.updateIfProviderIdentity.bind(agentSessionAccessor);
  const writing = vi
    .spyOn(agentSessionAccessor, 'updateIfProviderIdentity')
    .mockImplementationOnce(async (id, expected, data) => {
      expect(
        await agentSessionAccessor.rolloverProviderIdentity(id, {
          previousProviderSessionId: 'thread',
          providerSessionId: 'replacement',
          expectedUpdatedAt: expected.updatedAt,
          expectedProviderMetadata: expected.providerMetadata,
          providerMetadata: metadata,
        })
      ).toBe(1);
      return update(id, expected, data);
    });
  try {
    await expect(persistence.persist(session.id, observation('second'))).rejects.toThrow(
      'Stale provider config snapshot'
    );
    expect(writing).toHaveBeenCalledOnce();
    expect(
      await db.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } })
    ).toMatchObject({
      model: 'first',
      providerSessionId: 'replacement',
      providerMetadata: metadata,
    });
  } finally {
    writing.mockRestore();
  }
});

it('keeps the newer observation when it matches the durable snapshot while an older CAS is in flight', async () => {
  const session = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let superseded = false;
  const update = agentSessionAccessor.updateIfProviderIdentity.bind(agentSessionAccessor);
  const writing = vi
    .spyOn(agentSessionAccessor, 'updateIfProviderIdentity')
    .mockImplementationOnce(async (...args) => {
      started.resolve();
      await release.promise;
      return update(...args);
    });
  try {
    const old = persistence
      .persist(session.id, {
        ...observation('second'),
        assertCurrent: () => {
          if (superseded) {
            throw new Error('superseded');
          }
        },
      })
      .catch((error: unknown) => error);
    await started.promise;
    superseded = true;
    await persistence.persist(session.id, observation('first'));
    release.resolve();
    await old;
    expect(
      await db.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } })
    ).toMatchObject({
      model: 'first',
      providerMetadata: { acpConfigSnapshot: { observedModelId: 'first' } },
    });
  } finally {
    release.resolve();
    writing.mockRestore();
  }
});

it('compares optional ACP fields by their durable JSON representation', async () => {
  const session = await fixture();
  const unchanged = observation('first');
  unchanged.configOptions = unchanged.configOptions.map((option) => ({
    ...option,
    description: undefined,
  }));
  const sql = await captureSql(() => persistence.persist(session.id, unchanged));
  expect(sql).toEqual([expect.stringMatching(/^SELECT .*AgentSession/i)]);
});

it.each(['model', 'observedModelId'])(
  'repairs a stale %s even when the native options already match',
  async (field) => {
    const session = await fixture();
    const metadata = session.providerMetadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error('Missing fixture metadata');
    }
    await db.prisma.agentSession.update({
      where: { id: session.id },
      data:
        field === 'model'
          ? { model: 'stale' }
          : { providerMetadata: { ...metadata, observedModelId: 'stale' } },
    });
    await persistence.persist(session.id, observation('first'));
    expect(
      await db.prisma.agentSession.findUniqueOrThrow({ where: { id: session.id } })
    ).toMatchObject({
      model: 'first',
      providerMetadata: { observedModelId: 'first', legacy: 'retained' },
    });
  }
);

it('commits required startup persistence even when the accepted snapshot matches', async () => {
  const session = await fixture();
  const sql = await captureSql(() =>
    persistence.persist(session.id, { ...observation('first'), requirePersistence: true })
  );
  expect(sql.filter((statement) => statement.startsWith('UPDATE'))).toHaveLength(1);
});
