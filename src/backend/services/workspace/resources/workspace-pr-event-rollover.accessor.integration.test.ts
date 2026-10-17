import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';

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
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'w', projectId: 'project', name: 'Workspace', status: 'READY' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      providerSessionId: 'live',
      model: 'sonnet',
    },
  });
  await db.prisma.workspacePRMonitoring.create({
    data: { workspaceId: 'w', enabled: true, recipientSessionId: 'main' },
  });
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
beforeEach(async () => {
  await db.prisma.workspacePREvent.deleteMany();
  await db.prisma.agentSession.update({
    where: { id: 'main' },
    data: {
      provider: 'CLAUDE',
      providerSessionId: 'live',
      providerMetadata: {
        providerIdentityRollovers: [
          { previousProviderSessionId: 'original', providerSessionId: 'middle' },
          { previousProviderSessionId: 'middle', providerSessionId: 'live' },
        ],
      },
    },
  });
});
const identity = { sessionId: 'main', provider: 'CLAUDE' as const, providerSessionId: 'live' };
async function frozen(state: 'PENDING' | 'DISPATCHING' = 'DISPATCHING') {
  return await db.prisma.workspacePREvent.create({
    data: {
      id: 'event',
      workspaceId: 'w',
      kind: 'MONITORING_ENABLED',
      state,
      deduplicationKey: 'rollover',
      payload: {
        kind: 'MONITORING_ENABLED',
        workspaceId: 'w',
        bindingRevision: 0,
        replyToPrComments: true,
      },
      attempts: 1,
      deliveryId: 'frozen',
      deliverySessionId: 'main',
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'original',
      deliveryBindingRevision: 0,
      deliveryText: 'exact original message',
    },
  });
}
const request = { workspaceId: 'w', prId: null, bindingRevision: 0 };
const input = {
  deliveryId: 'frozen',
  sessionId: 'main',
  eventIds: ['event'],
  text: 'exact original message',
};

it.each(['DISPATCHING', 'PENDING'] as const)(
  'retries a proven-absent %s claim through transitive identity rollover',
  async (state) => {
    await frozen(state);
    expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
    await workspacePrEventAccessor.recoverClaim('frozen', false, identity);
    expect(await db.prisma.workspacePREvent.findUnique({ where: { id: 'event' } })).toMatchObject({
      state: 'PENDING',
      deliveryId: 'frozen',
      deliveryText: 'exact original message',
      deliverySessionId: 'main',
      deliveryProviderSessionId: 'live',
      attempts: 1,
    });
    expect(await workspacePrEventAccessor.claimDelivery(request, input)).toMatchObject({
      deliveryId: 'frozen',
      text: 'exact original message',
      deliveryProviderSessionId: 'live',
      attempt: 2,
    });
    expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
  }
);

it.each([
  {
    providerIdentityRollovers: [
      { previousProviderSessionId: 'original', providerSessionId: 'unrelated' },
    ],
  },
  {
    providerIdentityRollovers: [
      { previousProviderSessionId: 'original', providerSessionId: 'middle' },
      { previousProviderSessionId: 'middle', providerSessionId: 'original' },
    ],
  },
  { providerIdentityRollovers: 'invalid' },
  {},
])('does not rebind an unproven identity lineage %j', async (providerMetadata) => {
  await frozen();
  await db.prisma.agentSession.update({ where: { id: 'main' }, data: { providerMetadata } });
  await workspacePrEventAccessor.recoverClaim('frozen', false, identity);
  expect(
    (await db.prisma.workspacePREvent.findUnique({ where: { id: 'event' } }))
      ?.deliveryProviderSessionId
  ).toBe('original');
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
});

it.each([
  { ...identity, providerSessionId: 'stale' },
  { ...identity, provider: 'CODEX' as const },
  { ...identity, sessionId: 'other' },
])('fences stale receipt recovery identity %j', async (expectedIdentity) => {
  await frozen();
  await workspacePrEventAccessor.recoverClaim('frozen', false, expectedIdentity);
  expect(
    (await db.prisma.workspacePREvent.findUnique({ where: { id: 'event' } }))
      ?.deliveryProviderSessionId
  ).toBe('original');
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
});

it('acknowledges receipt in the original identity without retrying in the new identity', async () => {
  await frozen();
  await workspacePrEventAccessor.recoverClaim('frozen', true);
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: 'event' } })).toMatchObject({
    state: 'DELIVERED',
    deliveryProviderSessionId: 'original',
  });
  expect(await workspacePrEventAccessor.claimDelivery(request, input)).toBeNull();
});
