import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { workspacePrEventAccessor } from './workspace-pr-event.accessor';
import { workspacePrMonitoringAccessor } from './workspace-pr-monitoring.accessor';

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
  for (const id of ['w', 'other']) {
    await db.prisma.workspace.create({
      data: { id, projectId: 'project', name: id, status: 'READY' },
    });
  }
  await db.prisma.agentSession.create({
    data: {
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      model: 'sonnet',
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'foreign',
      workspaceId: 'other',
      workflow: 'implement',
      provider: 'CLAUDE',
      model: 'sonnet',
    },
  });
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

describe('durable monitoring', () => {
  it('rejects a cross-workspace recipient', async () => {
    await expect(
      workspacePrMonitoringAccessor.setBinding({
        workspaceId: 'w',
        recipientSessionId: 'foreign',
        enabled: true,
        expectedBindingRevision: 0,
      })
    ).rejects.toThrow();
  });
  it('rejects a stale binding after stop', async () => {
    const binding = await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      recipientSessionId: 'main',
      enabled: true,
      expectedBindingRevision: 0,
    });
    expect(binding.applied).toBe(true);
    await workspacePrMonitoringAccessor.pause('main', 'USER_STOPPED');
    const result = await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      recipientSessionId: 'main',
      enabled: true,
      expectedBindingRevision: binding.bindingRevision,
    });
    expect(result.applied).toBe(false);
    expect((await workspacePrMonitoringAccessor.get('w'))?.deliveryPauseReason).toBe(
      'USER_STOPPED'
    );
  });
  it('deduplicates events and allows only one concurrent claim', async () => {
    await workspacePrMonitoringAccessor.resume('main');
    const config = await workspacePrMonitoringAccessor.get('w');
    if (!config) {
      throw new Error('Missing monitoring config');
    }
    const draft = {
      kind: 'MONITORING_ENABLED' as const,
      deduplicationKey: 'control-test',
      payload: {
        kind: 'MONITORING_ENABLED' as const,
        workspaceId: 'w',
        bindingRevision: config.bindingRevision,
        replyToPrComments: true,
      },
    };
    await db.prisma.$transaction(async (tx) => {
      await workspacePrEventAccessor.insert(tx, 'w', null, [draft]);
      await workspacePrEventAccessor.insert(tx, 'w', null, [draft]);
    });
    const events = await workspacePrEventAccessor.listPending('w', null);
    expect(events).toHaveLength(1);
    const request = { workspaceId: 'w', prId: null, bindingRevision: config.bindingRevision };
    const claims = await Promise.all(
      ['one', 'two'].map((deliveryId) =>
        workspacePrEventAccessor.claimDelivery(request, {
          deliveryId,
          sessionId: 'main',
          eventIds: events.map((e) => e.id),
          text: 'frozen',
        })
      )
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await workspacePrEventAccessor.settleDelivery({
        deliveryId: 'wrong',
        sessionId: 'main',
        bindingRevision: config.bindingRevision,
        result: 'delivered',
      })
    ).toBe(false);
  });
  it('acknowledges a frozen retry when provider receipt arrives', async () => {
    const event = (await workspacePrEventAccessor.listPending('w', null))[0];
    if (!event?.deliveryId || event.deliveryBindingRevision === null) {
      throw new Error('Missing frozen claim');
    }
    await workspacePrEventAccessor.settleDelivery({
      deliveryId: event.deliveryId,
      sessionId: 'main',
      bindingRevision: event.deliveryBindingRevision,
      result: 'retry',
    });
    await workspacePrEventAccessor.recoverClaim(event.deliveryId, true);
    expect((await db.prisma.workspacePREvent.findUnique({ where: { id: event.id } }))?.state).toBe(
      'DELIVERED'
    );
  });
  it('preserves config when recipient is deleted and cascades workspace events', async () => {
    await db.prisma.agentSession.delete({ where: { id: 'main' } });
    expect((await workspacePrMonitoringAccessor.get('w'))?.recipientSessionId).toBeNull();
    await db.prisma.workspace.delete({ where: { id: 'w' } });
    expect(await db.prisma.workspacePREvent.count()).toBe(0);
  });
  it('renews exhausted retries on explicit resume without changing frozen delivery identity', async () => {
    await db.prisma.workspacePRMonitoring.create({
      data: {
        workspaceId: 'other',
        enabled: true,
        recipientSessionId: 'foreign',
        deliveryPauseReason: 'DELIVERY_FAILED',
      },
    });
    const event = await db.prisma.workspacePREvent.create({
      data: {
        workspaceId: 'other',
        kind: 'MONITORING_ENABLED',
        deduplicationKey: 'exhausted',
        payload: {
          kind: 'MONITORING_ENABLED',
          workspaceId: 'other',
          bindingRevision: 0,
          replyToPrComments: true,
        },
        attempts: 3,
        deliveryId: 'frozen',
        deliverySessionId: 'foreign',
        deliveryText: 'exact original text',
        deliveryBindingRevision: 0,
      },
    });
    await workspacePrMonitoringAccessor.resume('foreign');
    expect(await db.prisma.workspacePREvent.findUnique({ where: { id: event.id } })).toMatchObject({
      attempts: 0,
      state: 'PENDING',
      deliveryId: 'frozen',
      deliverySessionId: 'foreign',
      deliveryText: 'exact original text',
    });
    expect(
      await workspacePrEventAccessor.claimDelivery(
        { workspaceId: 'other', prId: null, bindingRevision: 1 },
        {
          deliveryId: 'frozen',
          sessionId: 'foreign',
          eventIds: [event.id],
          text: 'exact original text',
        }
      )
    ).toMatchObject({ attempt: 1 });
  });
});
