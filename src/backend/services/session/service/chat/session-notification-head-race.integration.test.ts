import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ChatIntentAccessor } from '@/backend/services/session/resources/chat-intent.accessor';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import {
  collectDispatchBatch,
  dispatchCollectedBatch,
} from '@/backend/services/session/service/dispatch/session-dispatch-batch';
import { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import { SessionNotificationDeliveryService } from '@/backend/services/session/service/lifecycle/session-notification-delivery.service';
import { sessionDomainService as domain } from '@/backend/services/session/service/session-domain.service';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentContentItem, QueuedMessage } from '@/shared/acp-protocol';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionChatIntentService } from './session-chat-intent.service';

let db: IntegrationDatabase;
let intents: SessionChatIntentService;
const settings = {
  selectedModel: 'sonnet',
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};
const message = (id: string): QueuedMessage => ({
  id,
  text: id,
  timestamp: new Date(0).toISOString(),
  settings: { ...settings },
});
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  domain.clearAllSessions();
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp', worktreeBasePath: '/tmp' },
  });
  await db.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'W' } });
  await db.prisma.agentSession.create({
    data: { id: 's', workspaceId: 'w', provider: 'CLAUDE', workflow: 'implement' },
  });
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  vi.spyOn(sessionDataService, 'findAgentSessionById').mockResolvedValue(
    unsafeCoerce({ workspace: { status: 'READY' } })
  );
});
async function queuedNotification(id: string) {
  await db.prisma.workspaceNotification.create({
    data: {
      id,
      workspaceId: 'w',
      sourceWorkspaceId: 'child',
      sourceWorkspaceName: 'Child',
      sourceProjectName: 'P',
      message: id,
    },
  });
  const queued = message(`workspace-notification-${id}`);
  domain.enqueue('s', queued);
  return queued;
}
function delivery() {
  const find = vi.fn(async (id: string) =>
    db.prisma.workspaceNotification.findUnique({ where: { id } })
  );
  const mark = vi.fn(async (ids: string[]) => {
    await db.prisma.workspaceNotification.updateMany({
      where: { id: { in: ids } },
      data: { deliveredAt: new Date() },
    });
  });
  const notifications = new SessionNotificationDeliveryService({
    notificationPort: {
      listPendingForDelivery: (workspaceId) =>
        db.prisma.workspaceNotification.findMany({ where: { workspaceId, deliveredAt: null } }),
      findForDelivery: find,
      markDelivered: mark,
    },
    queuePort: domain,
    transcriptPort: domain,
    deltaPort: domain,
  });
  return { notifications, find, mark, remove: vi.spyOn(notifications, 'removeDuplicateFromQueue') };
}
function dispatcher(notifications: SessionNotificationDeliveryService, pausedStart = false) {
  let started = !pausedStart;
  const start = vi.fn(() => {
    started = true;
    return Promise.resolve({});
  });
  const send = vi.fn<(id: string, content: string | AgentContentItem[]) => Promise<void>>(
    async () => {
      expect(
        (await db.prisma.workspaceNotification.findUniqueOrThrow({ where: { id: 'first' } }))
          .deliveredAt
      ).toBeNull();
    }
  );
  const background = {
    prepare: vi.fn(),
    validate: vi.fn(async () => true),
    fail: vi.fn(),
    complete: vi.fn(),
  };
  const service = new SessionDispatchService({
    chatIntent: intents,
    runtimeManager: { isSessionPromptInFlight: () => false, isSessionRunning: () => started },
    configService: {
      configureQueuedMessage: async (_id, row) => row.settings,
      resolveQueuedMessageSettings: (_id, row) => row.settings,
    },
    promptService: { sendSessionMessage: send, steerSessionMessage: vi.fn() },
    backgroundDelivery: background,
  });
  service.configure({
    initPolicy: unsafeCoerce({ getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }) }),
  });
  const getClient = vi.fn(() => (started ? {} : undefined));
  service.configureLifecycle({
    gate: {
      getGeneration: () => 1,
      isGenerationCurrent: () => true,
      isSessionStopping: () => false,
    },
    startup: {
      getSessionClient: getClient,
      getOrCreateSessionClient: start,
    },
    notificationDelivery: notifications,
  });
  return { service, send, start, background, getClient };
}

it.each(['selection read', 'delivery read', 'provider startup', 'pre-collector guard'])(
  'retains a pending notification when human priority changes during %s',
  async (phase) => {
    const first = await queuedNotification('first');
    const d = delivery();
    const h = dispatcher(d.notifications, phase === 'provider startup');
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    if (phase === 'delivery read') {
      d.find.mockImplementationOnce(async (id) => {
        const row = await db.prisma.workspaceNotification.findUnique({ where: { id } });
        entered.resolve();
        await release.promise;
        return row;
      });
    } else if (phase === 'selection read') {
      const check = intents.store.hasUncertainAttempt.bind(intents.store);
      vi.spyOn(intents.store, 'hasUncertainAttempt').mockImplementationOnce(async (id) => {
        const held = await check(id);
        entered.resolve();
        await release.promise;
        return held;
      });
    } else if (phase === 'provider startup') {
      const start = h.start.getMockImplementation()!;
      h.start.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return start();
      });
    }
    let pausedGuard = false;
    const guard = {
      check: async () => {
        if (phase === 'pre-collector guard' && !pausedGuard && h.getClient.mock.calls.length > 0) {
          pausedGuard = true;
          entered.resolve();
          await release.promise;
        }
      },
    };
    const dispatch = h.service.tryDispatchNextMessage('s', { guard });
    await entered.promise;
    await intents.accept('s', message('fresh-human'));
    expect(domain.getQueueSnapshot('s').map((row) => row.id)).toEqual(['fresh-human', first.id]);
    release.resolve();
    await dispatch;
    expect(h.send).toHaveBeenCalledExactlyOnceWith('s', `fresh-human\n\n${first.text}`, guard);
    expect(d.remove).not.toHaveBeenCalled();
    expect(d.mark).toHaveBeenCalledExactlyOnceWith(['first']);
    expect(domain.getQueueLength('s')).toBe(0);
    expect(
      (await db.prisma.workspaceNotification.findUniqueOrThrow({ where: { id: 'first' } }))
        .deliveredAt
    ).not.toBeNull();
    expect((await intents.store.find('s', 'fresh-human'))?.status).toBe('committed');
  }
);

it('never treats its displaced first notification as a tail duplicate', async () => {
  const first = await queuedNotification('first');
  const d = delivery();
  const claim = d.notifications.claimForDispatch('s', first.id);
  expect(claim.status).toBe('claimed');
  await intents.accept('s', message('fresh-human'));
  const batch = await collectDispatchBatch({
    sessionId: 's',
    first,
    notifications: d.notifications,
    prepareBackground: async () => true,
    isCurrent: () => true,
  });
  try {
    expect(domain.getQueueSnapshot('s').map((row) => row.id)).toEqual(['fresh-human', first.id]);
    expect(d.remove).not.toHaveBeenCalled();
    expect(d.mark).not.toHaveBeenCalled();
  } finally {
    batch.release();
    if (claim.status === 'claimed') {
      claim.release();
    }
  }
});

it('releases collected claims without taking a displaced multi-message batch after a collector guard await', async () => {
  const first = await queuedNotification('first');
  const second = await queuedNotification('second');
  const d = delivery();
  const claim = d.notifications.claimForDispatch('s', first.id);
  expect(claim.status).toBe('claimed');
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const collecting = collectDispatchBatch({
    sessionId: 's',
    first,
    notifications: d.notifications,
    prepareBackground: async () => true,
    isCurrent: () => true,
    guard: {
      check: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  });
  await entered.promise;
  await intents.accept('s', message('fresh-human'));
  release.resolve();
  const batch = await collecting;
  const send = vi.fn(async () => undefined);
  try {
    const result = await dispatchCollectedBatch({
      sessionId: 's',
      batch,
      isCurrent: () => true,
      send,
      onError: vi.fn(),
      onSuccess: vi.fn(),
      backgroundDelivery: {
        prepare: vi.fn(),
        validate: vi.fn(async () => true),
        fail: vi.fn(),
        complete: vi.fn(),
      },
    });
    expect(result).toBe('retry');
    expect(send).not.toHaveBeenCalled();
    expect(domain.getQueueSnapshot('s').map((row) => row.id)).toEqual([
      'fresh-human',
      first.id,
      second.id,
    ]);
    expect(d.remove).not.toHaveBeenCalled();
    expect(d.mark).not.toHaveBeenCalled();
    const releasedTail = d.notifications.claimForDispatch('s', second.id);
    expect(releasedTail.status).toBe('claimed');
    if (releasedTail.status === 'claimed') {
      releasedTail.release();
    }
  } finally {
    batch.release();
    if (claim.status === 'claimed') {
      claim.release();
    }
  }
});
