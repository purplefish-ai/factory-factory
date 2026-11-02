import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { durableRecoverySchema } from '@/shared/schemas/durable-recovery.schema';

let db: IntegrationDatabase;
let workspace: typeof import('@/backend/services/workspace');
let Domain: typeof import('../session-domain.service').sessionDomainService;
let Dispatcher: typeof import('../dispatch/session-dispatch.service').SessionDispatchService;
let Delivery: typeof import('./session-notification-delivery.service').SessionNotificationDeliveryService;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  vi.stubEnv('BASE_DIR', db.tempDir);
  workspace = await vi.importActual('@/backend/services/workspace');
  ({ sessionDomainService: Domain } = await vi.importActual('../session-domain.service'));
  ({ SessionDispatchService: Dispatcher } = await vi.importActual(
    '../dispatch/session-dispatch.service'
  ));
  ({ SessionNotificationDeliveryService: Delivery } = await vi.importActual(
    './session-notification-delivery.service'
  ));
});
beforeEach(async () => {
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Recovery',
      slug: 'recovery',
      repoPath: '/repo',
      worktreeBasePath: '/trees',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'target',
      projectId: 'project',
      name: 'Target',
      status: 'READY',
      worktreePath: '/tmp/notification-worktree',
    },
  });
  await db.prisma.agentSession.create({
    data: { id: 'session', workspaceId: 'target', provider: 'CLAUDE', workflow: 'default' },
  });
});
afterEach(async () => {
  Domain.clearAllSessions();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
  vi.unstubAllEnvs();
});
const empty = () =>
  durableRecoverySchema.parse(
    Object.fromEntries(
      Object.keys(durableRecoverySchema.shape).map((key) => [
        key,
        key === 'jsonStorage' ? { version: 1, jsonNulls: [] } : [],
      ])
    )
  );
function notification(id = 'notice', sourceWorkspaceId = 'deleted-source') {
  return {
    id,
    workspaceId: 'target',
    sourceWorkspaceId,
    sourceWorkspaceName: 'Source',
    sourceProjectName: 'Project',
    message: 'Historical follow-up',
    direction: 'CHILD_TO_PARENT' as const,
    recoveryHeld: false,
    deliveredAt: null as Date | null,
    createdAt: new Date('2026-01-01'),
  };
}

function deliveryHarness() {
  const service = new Delivery({
    notificationPort: workspace.workspaceNotificationService,
    queuePort: Domain,
    transcriptPort: {
      getTranscriptSnapshot: (id) => Domain.getTranscriptSnapshot(id),
      getHistoryHydrationSource: () => 'none',
      appendClaudeEvent: (id, message) => Domain.appendClaudeEvent(id, message),
    },
    deltaPort: Domain,
  });
  const send = vi.fn(() => Promise.resolve());
  const dispatcher = new Dispatcher({
    runtimeManager: { isSessionPromptInFlight: () => false, isSessionRunning: () => true },
    configService: {
      resolveQueuedMessageSettings: (_id, message) => message.settings,
      configureQueuedMessage: (_id, message) => Promise.resolve(message.settings),
    },
    promptService: {
      sendSessionMessage: send,
      steerSessionMessage: () => Promise.resolve({ outcome: 'injected' }),
    },
    backgroundDelivery: {
      prepare: vi.fn(),
      validate: () => Promise.resolve(true),
      fail: () => Promise.resolve(),
      complete: () => Promise.resolve(),
    },
  });
  dispatcher.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }) },
  });
  dispatcher.configureLifecycle({
    gate: {
      getGeneration: () => 0,
      isGenerationCurrent: () => true,
      isSessionStopping: () => false,
    },
    startup: { getSessionClient: () => ({}), getOrCreateSessionClient: () => Promise.resolve({}) },
    notificationDelivery: service,
  });
  return { service, dispatcher, send };
}

it.each(
  [null, new Date('2026-01-02')].flatMap((deliveredAt) =>
    [false, true].map((withHuman) => ({ deliveredAt, withHuman }))
  )
)(
  'blocks imported held notifications at head or inside human batch (human=$withHuman, deliveredAt=$deliveredAt)',
  async ({ deliveredAt, withHuman }) => {
    const original = notification();
    const data = {
      ...empty(),
      workspaceNotification: [
        {
          ...original,
          recoveryHeld: deliveredAt !== null,
          deliveredAt: deliveredAt?.toISOString() ?? null,
          createdAt: original.createdAt.toISOString(),
        },
      ],
    };
    await db.prisma.$transaction((tx) =>
      workspace.restoreRecoveryNotifications(tx, data, new Set(['target']), new Set(['target']))
    );
    const { service, dispatcher, send } = deliveryHarness();
    expect(
      await service.recoverPending({
        sessionId: 'session',
        workspaceId: 'target',
        assertAllowed: () => undefined,
      })
    ).toEqual({ dispatchableCount: 0 });
    if (withHuman) {
      Domain.enqueue('session', {
        id: 'human',
        text: 'Human request',
        timestamp: original.createdAt.toISOString(),
        settings: {
          selectedModel: null,
          reasoningEffort: null,
          thinkingEnabled: false,
          planModeEnabled: false,
        },
      });
    }
    Domain.enqueue('session', {
      id: 'workspace-notification-notice',
      text: 'Historical follow-up',
      timestamp: original.createdAt.toISOString(),
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    });
    await dispatcher.tryDispatchNextMessage('session');
    if (withHuman) {
      expect(send).toHaveBeenCalledExactlyOnceWith('session', 'Human request');
    } else {
      expect(send).not.toHaveBeenCalled();
    }
    expect(
      Domain.getTranscriptSnapshot('session')
        .filter((message) => message.source === 'user')
        .map(({ id }) => id)
    ).toEqual(withHuman ? ['human'] : []);
    // Even an erroneous direct acknowledgement must not fabricate delivery proof.
    await service.acknowledgeSuccessfulDispatch('workspace-notification-notice');
    expect(
      await db.prisma.workspaceNotification.findUnique({ where: { id: 'notice' } })
    ).toMatchObject({ recoveryHeld: true, deliveredAt });
  }
);

it.each([
  { inBackup: true, imported: false, exists: false, kept: false },
  { inBackup: true, imported: false, exists: true, kept: false },
  { inBackup: false, imported: false, exists: false, kept: true },
  { inBackup: false, imported: false, exists: true, kept: false },
  { inBackup: true, imported: true, exists: true, kept: true },
])(
  'applies the typed retained workspace rule for notification source $inBackup/$imported/$exists',
  async ({ inBackup, imported, exists, kept }) => {
    if (exists) {
      await db.prisma.workspace.create({
        data: { id: 'source', projectId: 'project', name: 'Source' },
      });
    }
    const row = notification('source-notice', 'source');
    const data = {
      ...empty(),
      workspaceNotification: [
        { ...row, deliveredAt: null, createdAt: row.createdAt.toISOString() },
      ],
    };
    await db.prisma.$transaction((tx) =>
      workspace.restoreRecoveryNotifications(
        tx,
        data,
        new Set(imported ? ['target', 'source'] : ['target']),
        new Set(inBackup ? ['target', 'source'] : ['target'])
      )
    );
    expect(await db.prisma.workspaceNotification.count()).toBe(Number(kept));
  }
);

it('continues ordinary unheld notification dispatch and records only real successful provider delivery', async () => {
  const row = await workspace.workspaceNotificationService.notifyParent({
    workspaceId: 'target',
    sourceWorkspaceId: 'deleted-source',
    sourceWorkspaceName: 'Source',
    sourceProjectName: 'Project',
    message: 'New live request',
  });
  const { service, dispatcher, send } = deliveryHarness();
  await expect(service.getDispatchState(row.id)).resolves.toBe('pending');
  Domain.enqueue('session', {
    id: `workspace-notification-${row.id}`,
    text: row.message,
    timestamp: row.createdAt.toISOString(),
    settings: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  });
  await dispatcher.tryDispatchNextMessage('session');
  expect(send).toHaveBeenCalledExactlyOnceWith('session', 'New live request');
  expect(await db.prisma.workspaceNotification.findUnique({ where: { id: row.id } })).toMatchObject(
    { recoveryHeld: false, deliveredAt: expect.any(Date) }
  );
});
