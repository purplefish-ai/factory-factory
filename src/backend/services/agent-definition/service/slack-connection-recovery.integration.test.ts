import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '@/backend/services/agent-definition';
import * as recovery from '@/backend/services/agent-definition/resources/slack-connection-recovery';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { slackConnectionsRecoverySchema } from '@/shared/schemas/slack-connections-recovery.schema';
import fixture from '@/shared/testing/recovery-slack-connections-v8.fixture.json';
import type { PrismaClient } from '@prisma-gen/client';
import { SlackConnectionService } from './slack-connection.service';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
const request = vi.fn<typeof fetch>();
const crypto = {
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  decrypt: vi.fn((value: string) => value.slice(10)),
};
const service = new SlackConnectionService(crypto, request);
const section = () => slackConnectionsRecoverySchema.parse(fixture.data.recovery.slackConnections);
beforeEach(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  request.mockReset();
  crypto.encrypt.mockClear();
  crypto.decrypt.mockClear();
}, 30_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await destroyIntegrationDatabase(db);
}, 30_000);
function identify(team: string) {
  request.mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        team_id: team,
        team: 'Company',
        user_id: 'U-bot',
        bot_id: 'B-bot',
      })
    )
  );
}
it('exports real owner-authored Slack metadata in stable order with credential-free projections', async () => {
  identify('T-one');
  const first = await service.connect({ botToken: 'xoxb-source-one' });
  identify('T-two');
  const second = await service.connect({ botToken: 'xoxb-source-two' });
  await service.disconnect(second.id);
  const times = {
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-02T10:00:00.000Z'),
  };
  await db.prisma.agentConnection.updateMany({ data: times });
  await db.prisma.agentConnection.create({
    data: {
      provider: 'GITHUB',
      externalId: 'T-gh',
      name: 'GitHub',
      credentialsEncrypted: 'hidden-github',
    },
  });
  const read = vi.spyOn(db.prisma.agentConnection, 'findMany');
  const exported = await recovery.exportSlackConnectionsRecovery(db.prisma);
  expect(read).toHaveBeenCalledExactlyOnceWith({
    where: { provider: 'SLACK' },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      provider: true,
      externalId: true,
      name: true,
      isEnabled: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  expect(exported).toEqual({
    version: 1,
    connections: [
      {
        id: first.id,
        provider: 'SLACK',
        externalId: 'T-one',
        name: 'Company',
        isEnabled: true,
        createdAt: times.createdAt.toISOString(),
        updatedAt: times.updatedAt.toISOString(),
      },
      {
        id: second.id,
        provider: 'SLACK',
        externalId: 'T-two',
        name: 'Company',
        isEnabled: false,
        createdAt: times.createdAt.toISOString(),
        updatedAt: times.updatedAt.toISOString(),
      },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  });
  expect(JSON.stringify(exported)).not.toMatch(/encrypted|xoxb|hidden-github/);
});
describe('global occupied identities', () => {
  beforeEach(async () => {
    await createLedgerFixture(db, runtime);
    await db.prisma.agentConnection.createMany({
      data: Array.from({ length: 1100 }, (_, n) => ({
        id: `occupied-${n}`,
        provider: n < 2 ? 'SLACK' : 'GITHUB',
        externalId: `T-${n}`,
        name: `Local ${n}`,
        isEnabled: true,
        credentialsEncrypted: 'local-cipher',
      })),
    });
    expect(await db.prisma.agentConnection.count()).toBe(1101);
  }, 30_000);
  it('plans all 1101 identities once and exclusively counts PK, Slack-pair and combined collisions while preserving local authority', async () => {
    const before = await db.prisma.agentConnection.findMany({ orderBy: { id: 'asc' } });
    const triggers = await db.prisma.agentTrigger.findMany();
    const untouched = await runtimeState();
    const base = section().connections[0]!;
    const input = slackConnectionsRecoverySchema.parse({
      version: 1,
      connections: [
        { ...base, id: 'occupied-2', externalId: 'new-team' },
        { ...base, id: 'free-pair', externalId: 'T-0' },
        { ...base, id: 'occupied-4', externalId: 'T-1' },
        { ...base, id: '__proto__', externalId: 'T-3' },
        { ...base, id: 'free-enabled', externalId: ' T:free ' },
        { ...base, id: 'free-disabled', externalId: ' ', isEnabled: false },
      ],
    });
    const read = vi.spyOn(db.prisma.agentConnection, 'findMany');
    const plan = await recovery.planSlackConnectionsRecovery(db.prisma, input);
    expect(read).toHaveBeenCalledExactlyOnceWith({
      select: { id: true, provider: true, externalId: true },
    });
    expect(plan.map(({ row }) => row.id)).toEqual(input.connections.map(({ id }) => id));
    expect(await recovery.restoreSlackConnectionsRecovery(db.prisma, plan)).toEqual({
      model: 'AgentConnection',
      imported: 3,
      skipped: 3,
      sourceEnabled: 5,
      restoredDisabled: 3,
      reasons: { EXISTING_IDENTITY: 3 },
    });
    const originalIds = new Set(before.map((row) => row.id));
    expect(
      (await db.prisma.agentConnection.findMany({ orderBy: { id: 'asc' } })).filter((row) =>
        originalIds.has(row.id)
      )
    ).toEqual(before);
    expect(await db.prisma.agentTrigger.findMany()).toEqual(triggers);
    expect(await runtimeState()).toEqual(untouched);
    expect(
      await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: '__proto__' } })
    ).toMatchObject({ externalId: 'T-3', credentialsEncrypted: null, isEnabled: false });
    expect(request).not.toHaveBeenCalled();
    expect(crypto.encrypt).not.toHaveBeenCalled();
  });
});

function runtimeState() {
  return Promise.all([
    db.prisma.agentDefinition.findMany(),
    db.prisma.agentTrigger.findMany(),
    db.prisma.agentProposal.findMany(),
    db.prisma.agentRun.findMany(),
    db.prisma.agentEvent.findMany(),
    db.prisma.agentEvaluation.findMany(),
    db.prisma.agentInitialDelivery.findMany(),
    db.prisma.agentSourceState.findMany(),
    db.prisma.agentSourcePage.findMany(),
    db.prisma.agentSourceBaseline.findMany(),
    db.prisma.agentSourceCheckpoint.findMany(),
    db.prisma.agentSourceHead.findMany(),
  ]);
}
