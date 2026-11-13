import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import type { PrismaClient } from '@prisma-gen/client';
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
async function readEvent(id: string) {
  const row = await db.prisma.workspacePREvent.findUniqueOrThrow({ where: { id } });
  return workspacePrEventAccessor.projectEvents(
    [row],
    await db.prisma.workspacePRDelivery.findMany()
  )[0];
}

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
      providerSessionId: 'original',
      model: 'sonnet',
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'foreign',
      workspaceId: 'other',
      workflow: 'implement',
      provider: 'CLAUDE',
      providerSessionId: 'original',
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
    expect((await readEvent(event.id))?.state).toBe('DELIVERED');
  });
  it('enables monitoring without creating PR events and keeps retries idempotent', async () => {
    const current = await workspacePrMonitoringAccessor.get('w');
    const disabled = await workspacePrMonitoringAccessor.setBinding({
      workspaceId: 'w',
      enabled: false,
      recipientSessionId: null,
      expectedBindingRevision: current?.bindingRevision ?? 0,
    });
    expect(disabled.applied).toBe(true);
    const before = await workspacePrMonitoringAccessor.get('w');
    if (!before) {
      throw new Error('Missing config');
    }
    expect(before).toMatchObject({ enabled: false, recipientSessionId: null });
    const input = {
      workspaceId: 'w',
      enabled: true,
      recipientSessionId: 'main',
      expectedBindingRevision: before.bindingRevision,
      replyToPrComments: false,
    };
    const enabled = await workspacePrMonitoringAccessor.setBinding(input);
    expect(enabled).toEqual({ applied: true, bindingRevision: before.bindingRevision + 1 });
    expect(await workspacePrMonitoringAccessor.get('w')).toMatchObject({
      enabled: true,
      recipientSessionId: 'main',
      bindingRevision: enabled.bindingRevision,
    });
    const retry = await workspacePrMonitoringAccessor.setBinding({
      ...input,
      expectedBindingRevision: enabled.bindingRevision,
    });
    expect(retry).toEqual(enabled);
    const control = await db.prisma.workspacePREvent.findMany({
      where: { workspaceId: 'w', deduplicationKey: `enabled:${enabled.bindingRevision}` },
    });
    expect(control).toEqual([]);
    expect(await workspacePrEventAccessor.listPending('w')).toEqual([]);
    await workspacePrMonitoringAccessor.pause('main', 'USER_STOPPED');
    expect((await workspacePrMonitoringAccessor.get('w'))?.deliveryPauseReason).toBe(
      'USER_STOPPED'
    );
    await workspacePrMonitoringAccessor.resume('main');
  });
  it('preserves a user stop across legacy retirement and rejects stale completion', async () => {
    const config = await workspacePrMonitoringAccessor.get('w');
    if (!config) {
      throw new Error('Missing config');
    }
    await workspacePrMonitoringAccessor.pauseWorkspace('w', 'LEGACY_FIXER', config.bindingRevision);
    await workspacePrMonitoringAccessor.pause('main', 'USER_STOPPED');
    await workspacePrMonitoringAccessor.completeLegacyRetirement('w', config.bindingRevision + 1);
    expect((await workspacePrMonitoringAccessor.get('w'))?.deliveryPauseReason).toBe(
      'LEGACY_FIXER_USER_STOPPED'
    );
    await workspacePrMonitoringAccessor.resume('main');
    expect((await workspacePrMonitoringAccessor.get('w'))?.deliveryPauseReason).toBe(
      'LEGACY_FIXER_USER_STOPPED'
    );
    await workspacePrMonitoringAccessor.completeLegacyRetirement('w', config.bindingRevision + 2);
    expect((await workspacePrMonitoringAccessor.get('w'))?.deliveryPauseReason).toBe(
      'USER_STOPPED'
    );
    await workspacePrMonitoringAccessor.resume('main');
    expect((await workspacePrMonitoringAccessor.get('w'))?.deliveryPauseReason).toBeNull();
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
        deliveryProvider: 'CLAUDE',
        deliveryProviderSessionId: 'original',
        deliveryText: 'exact original text',
        deliveryBindingRevision: 0,
      },
    });
    await workspacePrMonitoringAccessor.resume('foreign');
    expect(await readEvent(event.id)).toMatchObject({
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

describe('binding changes', () => {
  /** A workspace with two ordinary conversations, a fixer, a dedicated PR conversation and a PR. */
  async function seedWorkspace(id: string) {
    await db.prisma.workspace.create({
      data: { id, projectId: 'project', name: id, status: 'READY' },
    });
    await db.prisma.workspacePR.create({
      data: { id: `${id}-pr`, workspaceId: id, url: `https://github.com/org/${id}/pull/1` },
    });
    await db.prisma.agentSession.createMany({
      data: [
        { id: `${id}-a`, workspaceId: id, workflow: 'implement', provider: 'CLAUDE' },
        { id: `${id}-b`, workspaceId: id, workflow: 'code', provider: 'CODEX' },
        { id: `${id}-fixer`, workspaceId: id, workflow: 'ratchet', provider: 'CLAUDE' },
        {
          id: `${id}-dedicated`,
          workspaceId: id,
          workspacePrId: `${id}-pr`,
          workflow: 'pr-monitoring',
          provider: 'CLAUDE',
        },
      ],
    });
  }
  async function bind(workspaceId: string, enabled: boolean, recipientSessionId?: string) {
    const config = await workspacePrMonitoringAccessor.get(workspaceId);
    return workspacePrMonitoringAccessor.setBinding({
      workspaceId,
      enabled,
      expectedBindingRevision: config?.bindingRevision ?? 0,
      ...(recipientSessionId ? { recipientSessionId } : {}),
    });
  }
  async function pendingFact(workspaceId: string, key: string) {
    const [id] = await db.prisma.$transaction((tx) =>
      workspacePrEventAccessor.insert(tx, workspaceId, `${workspaceId}-pr`, [
        {
          kind: 'CI_FAILED',
          deduplicationKey: key,
          payload: {
            kind: 'CI_FAILED',
            target: { workspaceId, prId: `${workspaceId}-pr` },
            observation: { ...redObservation, url: `https://github.com/org/${workspaceId}/pull/1` },
          },
        },
      ])
    );
    if (!id) {
      throw new Error('Missing event');
    }
    return id;
  }
  const epoch = async (workspaceId: string) =>
    (await workspacePrMonitoringAccessor.get(workspaceId))?.eventEpoch;

  it('cancels unclaimed PR facts when monitoring turns off', async () => {
    await seedWorkspace('off');
    await bind('off', true, 'off-a');
    const id = await pendingFact('off', 'failure');
    expect(await readEvent(id)).toMatchObject({ state: 'PENDING' });

    expect(await bind('off', false)).toMatchObject({ applied: true });

    expect(await readEvent(id)).toMatchObject({ state: 'CANCELLED' });
    expect(await workspacePrEventAccessor.listPending('off')).toEqual([]);
  });

  it('starts a new observation epoch when monitoring turns on or changes recipient', async () => {
    await seedWorkspace('epoch');
    await bind('epoch', true, 'epoch-a');
    const enabled = await epoch('epoch');
    await bind('epoch', true, 'epoch-a');
    expect(await epoch('epoch')).toBe(enabled);

    const id = await pendingFact('epoch', 'failure');
    await bind('epoch', true, 'epoch-b');
    expect(await epoch('epoch')).toBe((enabled ?? 0) + 1);
    expect(await readEvent(id)).toMatchObject({ state: 'CANCELLED' });

    await bind('epoch', false);
    expect(await epoch('epoch')).toBe((enabled ?? 0) + 1);
    await bind('epoch', true);
    expect(await epoch('epoch')).toBe((enabled ?? 0) + 2);
  });

  it('unbinds a restored recipient that is missing, foreign or not an ordinary conversation', async () => {
    await seedWorkspace('restored');
    const backup = {
      enabled: false,
      deliveryMode: 'MAIN' as const,
      bindingRevision: 4,
      eventEpoch: 2,
      deliveryPauseReason: null,
      legacySessionIds: [],
      lastCheckedAt: null,
    };
    for (const [recipientSessionId, expected] of [
      ['restored-a', 'restored-a'],
      ['missing', null],
      ['foreign', null],
      ['restored-fixer', null],
      ['restored-dedicated', null],
    ] as const) {
      await db.prisma.$transaction((tx) =>
        workspacePrMonitoringAccessor.restoreBackup(tx, 'restored', {
          ...backup,
          recipientSessionId,
        })
      );
      expect(await workspacePrMonitoringAccessor.get('restored')).toMatchObject({
        recipientSessionId: expected,
        bindingRevision: 4,
      });
    }
  });
});
