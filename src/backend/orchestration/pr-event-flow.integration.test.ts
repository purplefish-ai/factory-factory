import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  workspacePRMonitoringService,
  workspacePrSnapshotService,
} from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined, busy: false }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing test database');
    }
    return state.prisma;
  },
}));
vi.mock('@/backend/services/session', () => ({
  acpRuntimeManager: { isSessionWorking: () => state.busy },
  sessionDomainService: { getPendingInteractiveRequest: () => null },
  sessionDataService: {
    findPRDedicatedSession: async ({
      workspaceId,
      prId,
    }: {
      workspaceId: string;
      prId: string;
    }) => {
      const bound = await state.prisma?.workspacePRDedicatedSession.findUnique({
        where: { prId },
        include: { session: { include: { workspace: true } } },
      });
      return bound?.session?.workspaceId === workspaceId ? bound.session : null;
    },
    findAgentSessionById: (id: string) =>
      state.prisma?.agentSession.findUnique({ where: { id }, include: { workspace: true } }),
  },
  sessionBackgroundDeliveryService: {},
  chatMessageHandlerService: {},
  findPRDeliveryReceipt: vi.fn(),
}));
vi.mock('./pr-observation.orchestrator', () => ({
  observeMonitoredPR: vi.fn(async () => true),
  recipientCanDispatch: vi.fn(async () => true),
}));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({ ratchetReplyToPrComments: true })) },
}));

import { prBackgroundDeliveryPort } from './pr-event-delivery-port';
import { preparePRDelivery } from './pr-event-delivery.orchestrator';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
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
    data: {
      id: 'w',
      projectId: 'project',
      name: 'Workspace',
      status: 'READY',
      prMonitoring: { create: { enabled: true, bindingRevision: 1, eventEpoch: 1 } },
      prs: {
        create: [
          { id: 'p', url: redObservation.url },
          { id: 'sibling', url: 'https://github.com/org/repo/pull/2' },
        ],
      },
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      model: 'custom-model',
      provider: 'CODEX',
      providerSessionId: 'existing-main',
    },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { recipientSessionId: 'main' },
  });
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});
it('commits facts and events together, rejects stale writes, and preserves a sibling update', async () => {
  const target = { workspaceId: 'w', prId: 'p' };
  const input = {
    target,
    expectedPrRevision: 0,
    expectedEventEpoch: 1,
    observation: redObservation,
  };
  expect(await workspacePrSnapshotService.acceptMonitoredObservation(input)).toMatchObject({
    applied: true,
  });
  expect(
    await workspacePrSnapshotService.acceptMonitoredObservation({
      ...input,
      observation: { ...redObservation, ciStatus: 'SUCCESS' },
    })
  ).toEqual({ applied: false, eventIds: [] });
  expect(await workspacePrSnapshotService.find(target)).toMatchObject({
    ciStatus: 'FAILURE',
    revision: 1,
    observation: redObservation,
  });
  const sibling = {
    ...redObservation,
    url: 'https://github.com/org/repo/pull/2',
    number: 2,
    headSha: 'sibling-head',
  };
  await workspacePrSnapshotService.acceptMonitoredObservation({
    target: { workspaceId: 'w', prId: 'sibling' },
    expectedPrRevision: 0,
    expectedEventEpoch: 1,
    observation: sibling,
  });
  await workspacePrSnapshotService.acceptMonitoredObservation({
    ...input,
    expectedPrRevision: 1,
    observation: { ...redObservation, prState: 'MERGED', ciStatus: 'SUCCESS' },
  });
  expect(
    (await workspacePRMonitoringService.listPending('w', 'sibling')).map((e) => e.kind)
  ).toEqual(['CI_FAILED']);
  expect(await db.prisma.agentSession.count()).toBe(1);
});
it('defers a busy main session, then freezes one bounded update and reuses it on retry', async () => {
  const request = { workspaceId: 'w', prId: 'sibling', bindingRevision: 1 };
  state.busy = true;
  expect(await preparePRDelivery({ sessionId: 'main', request })).toMatchObject({
    status: 'blocked',
  });
  expect((await workspacePRMonitoringService.listPending('w', 'sibling'))[0]).toMatchObject({
    attempts: 0,
    deliveryId: null,
  });
  state.busy = false;
  const prepared = await preparePRDelivery({ sessionId: 'main', request });
  expect(prepared.status).toBe('ready');
  if (prepared.status !== 'ready') {
    throw new Error('Expected delivery');
  }
  expect(prepared.delivery.text).toContain('PR update: "org/repo" #2');
  expect(Buffer.byteLength(prepared.delivery.text)).toBeLessThanOrEqual(16_384);
  await prBackgroundDeliveryPort.fail(prepared.delivery, new Error('temporary transport failure'));
  const retry = await preparePRDelivery({ sessionId: 'main', request });
  expect(retry).toMatchObject({
    status: 'ready',
    delivery: {
      deliveryId: prepared.delivery.deliveryId,
      text: prepared.delivery.text,
      attempt: 2,
    },
  });
  if (retry.status !== 'ready') {
    throw new Error('Expected retry');
  }
  await prBackgroundDeliveryPort.complete(retry.delivery);
  expect(await workspacePRMonitoringService.listPending('w', 'sibling')).toEqual([]);
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'main' } })).toMatchObject({
    model: 'custom-model',
    providerSessionId: 'existing-main',
  });
  expect(await db.prisma.agentSession.count()).toBe(1);
});

it('delivers a dedicated PR batch through the same ledger and guards sibling recipients', async () => {
  await db.prisma.agentSession.create({
    data: {
      id: 'dedicated',
      workspaceId: 'w',
      workspacePrId: 'p',
      workflow: 'pr-monitoring',
      model: 'custom',
      provider: 'CODEX',
      providerSessionId: 'dedicated-provider',
    },
  });
  await db.prisma.workspacePRDedicatedSession.create({
    data: { prId: 'p', sessionId: 'dedicated' },
  });
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: {
      enabled: true,
      deliveryMode: 'DEDICATED',
      bindingRevision: 100,
      deliveryPauseReason: null,
    },
  });
  await db.prisma.workspacePREvent.deleteMany({ where: { workspaceId: 'w' } });
  await db.prisma.workspacePREvent.create({
    data: {
      id: 'dedicated-event',
      workspaceId: 'w',
      prId: 'p',
      kind: 'CI_FAILED',
      deduplicationKey: 'dedicated-event',
      payload: {
        kind: 'CI_FAILED',
        target: { workspaceId: 'w', prId: 'p' },
        observation: redObservation,
      },
    },
  });
  const request = {
    workspaceId: 'w',
    prId: 'p',
    bindingRevision: 100,
    deliveryMode: 'DEDICATED' as const,
  };
  expect(await preparePRDelivery({ sessionId: 'main', request })).toEqual({ status: 'discard' });
  const result = await preparePRDelivery({ sessionId: 'dedicated', request });
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') {
    throw new Error('expected dedicated claim');
  }
  expect(result.delivery.text).toContain('dedicated conversation');
  expect(result.delivery.deliveryProviderSessionId).toBe('dedicated-provider');
  expect(await prBackgroundDeliveryPort.validate(result.delivery)).toBe(true);
  await db.prisma.workspacePRMonitoring.update({
    where: { workspaceId: 'w' },
    data: { deliveryMode: 'MAIN', bindingRevision: 101 },
  });
  expect(await prBackgroundDeliveryPort.validate(result.delivery)).toBe(false);
  const frozen = await db.prisma.workspacePREvent.findUniqueOrThrow({
    where: { id: 'dedicated-event' },
  });
  expect(frozen.deliveryText).toBe(result.delivery.text);
  expect(frozen.deliverySessionId).toBe('dedicated');
});
