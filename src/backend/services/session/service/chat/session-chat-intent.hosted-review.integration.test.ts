import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ChatIntentAccessor } from '@/backend/services/session/resources/chat-intent.accessor';
import { PromptNotInvokedError } from '@/backend/services/session/service/acp/acp-prompt-invocation';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import type { SessionDispatchDependencies } from '@/backend/services/session/service/dispatch/session-dispatch.types';
import { SessionQueuedSteering } from '@/backend/services/session/service/dispatch/session-queued-steering';
import { sessionDomainService as domain } from '@/backend/services/session/service/session-domain.service';
import {
  createIntegrationDatabase,
  clearIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { QueuedMessage } from '@/shared/acp-protocol';
import {
  buildWorkspaceNotificationMessageText,
  workspaceNotificationMessageId,
} from '@/shared/workspace-notifications';
import { SessionChatIntentService } from './session-chat-intent.service';

let db: IntegrationDatabase;
let intents: SessionChatIntentService;
const settings = {
  selectedModel: 'sonnet',
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};
const message = (id: string, text = id): QueuedMessage => ({
  id,
  text,
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
    data: { id: 'p', name: 'Project', slug: 'p', worktreeBasePath: '/tmp', repoPath: '/tmp' },
  });
  await db.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'Workspace' } });
  await db.prisma.agentSession.create({
    data: { id: 's', workspaceId: 'w', workflow: 'implement', provider: 'CLAUDE' },
  });
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
});
function dispatcher(
  send: SessionDispatchDependencies['promptService']['sendSessionMessage'] = vi.fn(() =>
    Promise.resolve()
  ),
  options: {
    promptInFlight?: boolean;
    stopped?: boolean;
    runtimeManager?: SessionDispatchDependencies['runtimeManager'];
    configService?: SessionDispatchDependencies['configService'];
    client?: unknown;
    isCurrent?: () => boolean;
    steer?: SessionDispatchDependencies['promptService']['steerSessionMessage'];
  } = {}
) {
  let started = !options.stopped;
  const start = vi.fn(() => {
    started = true;
    return Promise.resolve(options.client ?? {});
  });
  const background = {
    prepare: vi.fn(),
    validate: vi.fn(async () => true),
    fail: vi.fn(),
    complete: vi.fn(),
  };
  const configured = vi.fn(async (_id: string, msg: QueuedMessage) => msg.settings);
  const notificationClaim = vi.fn(() => ({ status: 'not_notification' as const }));
  const service = new SessionDispatchService({
    chatIntent: intents,
    runtimeManager: options.runtimeManager ?? {
      isSessionPromptInFlight: () => options.promptInFlight ?? false,
      isSessionRunning: () => started,
    },
    configService: options.configService ?? {
      configureQueuedMessage: configured,
      resolveQueuedMessageSettings: (_id, msg) => msg.settings,
    },
    promptService: { sendSessionMessage: send, steerSessionMessage: options.steer ?? vi.fn() },
    backgroundDelivery: background,
  });
  service.configure({
    initPolicy: { getWorkspaceInitPolicy: () => ({ dispatchPolicy: 'allowed' }) } as never,
  });
  service.configureLifecycle({
    gate: {
      getGeneration: () => 1,
      isGenerationCurrent: options.isCurrent ?? (() => true),
      isSessionStopping: () => false,
    },
    startup: {
      getSessionClient: () => (started ? (options.client ?? {}) : undefined),
      getOrCreateSessionClient: start,
    },
    notificationDelivery: {
      claimForDispatch: notificationClaim,
      getDispatchState: async () => 'pending',
      acknowledgeSuccessfulDispatch: vi.fn(),
      recoverPending: vi.fn(),
      removeBlockedFromQueue: () => false,
      resetSession: vi.fn(),
      isNotificationMessage: (id) => id.startsWith('workspace-notification-'),
    },
  });
  vi.spyOn(sessionDataService, 'findAgentSessionById').mockResolvedValue({
    workspace: { status: 'READY' },
  } as never);
  return { service, send, configured, background, start, notificationClaim };
}
it('fences steering when desired settings change after its captured revision', async () => {
  await intents.accept('s', message('one'));
  const claim = intents.claim.bind(intents);
  vi.spyOn(intents, 'claim').mockImplementationOnce(async (...args) => {
    await intents.override('s', Date.now(), { selectedModel: 'newest' });
    return claim(...args);
  });
  const send = vi.fn(async () => ({ outcome: 'injected' as const }));
  const steering = new SessionQueuedSteering({
    chatIntent: () => intents,
    generation: () => 1,
    captureGuard: () => () => true,
    isAllowed: async () => true,
    isPromptInFlight: () => true,
    send,
    dispatch: async () => undefined,
  });
  await expect(steering.steer('s', 'one')).rejects.toThrow('desired settings changed');
  expect(send).not.toHaveBeenCalled();
  expect(await db.prisma.promptDispatchAttempt.count()).toBe(0);
  expect((await intents.store.find('s', 'one'))?.status).toBe('queued');
  expect(domain.peekNextMessage('s')?.settings.selectedModel).toBe('newest');
});

it('retains uncertain steering without publishing failure into a replacement runtime', async () => {
  await intents.accept('s', message('one'));
  let current = true;
  const entered = createDeferred<void>();
  const response = createDeferred<{ outcome: 'injected' }>();
  const steering = new SessionQueuedSteering({
    chatIntent: () => intents,
    generation: () => 1,
    captureGuard: () => () => current,
    isAllowed: async () => true,
    isPromptInFlight: () => true,
    send: () => {
      entered.resolve();
      return response.promise;
    },
    dispatch: async () => undefined,
  });
  const result = expect(steering.steer('s', 'one')).rejects.toThrow('uncertain');
  await entered.promise;
  current = false;
  domain.clearAllSessions();
  const failed = vi.spyOn(domain, 'failMessage');
  response.reject(new Error('late provider failure'));
  await result;
  expect(failed).not.toHaveBeenCalled();
  expect((await intents.store.find('s', 'one'))?.status).toBe('uncertain');
  expect(domain.getTranscriptSnapshot('s')).toEqual([]);
});

it('removes provisional transcript entries before retrying a confirmed non-invoked prompt', async () => {
  await intents.accept('s', message('one'));
  const send = vi
    .fn<SessionDispatchDependencies['promptService']['sendSessionMessage']>()
    .mockRejectedValueOnce(new PromptNotInvokedError(new Error('before RPC')))
    .mockResolvedValue(undefined);
  const h = dispatcher(send);
  const retryEntered = createDeferred<void>();
  const release = createDeferred<void>();
  h.configured
    .mockImplementationOnce(async () => settings)
    .mockImplementationOnce(async () => {
      retryEntered.resolve();
      await release.promise;
      return settings;
    });
  const dispatch = h.service.tryDispatchNextMessage('s');
  await retryEntered.promise;
  try {
    expect(domain.getTranscriptSnapshot('s')).toEqual([]);
    expect((await intents.store.find('s', 'one'))?.status).toBe('queued');
  } finally {
    release.resolve();
    await dispatch;
  }
  expect(send).toHaveBeenCalledTimes(2);
  expect((await intents.store.find('s', 'one'))?.status).toBe('committed');
  expect(domain.getTranscriptSnapshot('s')).toHaveLength(1);
});

it('refreshes persisted desired settings before freezing a valid steering attempt', async () => {
  await intents.accept('s', message('one'));
  await intents.store.override('s', Date.now(), { selectedModel: 'persisted-newest' });
  const send = vi.fn(async () => ({ outcome: 'injected' as const }));
  const steering = new SessionQueuedSteering({
    chatIntent: () => intents,
    generation: () => 1,
    captureGuard: () => () => true,
    isAllowed: async () => true,
    isPromptInFlight: () => true,
    send,
    dispatch: async () => undefined,
  });
  await steering.steer('s', 'one');
  expect(send).toHaveBeenCalledOnce();
  const attempt = await db.prisma.promptDispatchAttempt.findFirstOrThrow();
  expect(attempt.effectiveSettings).toMatchObject({ selectedModel: 'persisted-newest' });
  expect(attempt.members).toEqual([expect.objectContaining({ messageId: 'one', revision: 1 })]);
});

it.each(['new input', 'already restored order'])(
  'dispatches human input around held notifications (%s) without releasing mixed proof',
  async (ordering) => {
    const oldNotification = await db.prisma.workspaceNotification.create({
      data: {
        id: 'old-notification',
        workspaceId: 'w',
        sourceWorkspaceId: 'old-child',
        sourceWorkspaceName: 'Child',
        sourceProjectName: 'Project',
        message: 'earlier notification',
      },
    });
    const notification = await db.prisma.workspaceNotification.create({
      data: {
        id: 'later-notification',
        workspaceId: 'w',
        sourceWorkspaceId: 'old-child',
        sourceWorkspaceName: 'Child',
        sourceProjectName: 'Project',
        message: 'held notification',
      },
    });
    await intents.accept('s', message('old-human'));
    domain.enqueue(
      's',
      message(
        workspaceNotificationMessageId(oldNotification.id),
        buildWorkspaceNotificationMessageText(oldNotification)
      )
    );
    const originalBatch = domain.getQueueSnapshot('s');
    const uncertainId = await intents.claim(
      's',
      originalBatch,
      originalBatch.map((row) => row.text).join('\n\n'),
      settings,
      1
    );
    expect(uncertainId).toBeTypeOf('string');
    domain.takeQueuedMessages('s', originalBatch);
    const proof = await db.prisma.promptDispatchAttempt.findUniqueOrThrow({
      where: { id: uncertainId! },
    });
    const notificationProof = await db.prisma.workspaceNotification.findMany({
      orderBy: { id: 'asc' },
    });
    const held = message(
      workspaceNotificationMessageId(notification.id),
      buildWorkspaceNotificationMessageText(notification)
    );
    domain.enqueue('s', held);
    await intents.accept('s', message('fresh-one'));
    await intents.accept('s', message('fresh-two'));
    if (ordering === 'already restored order') {
      // Actual queue operations recreate a legacy/restored external-first order.
      domain.removeQueuedMessage('s', held.id, { expectedMessage: held });
      domain.requeueFront('s', held);
    }
    const h = dispatcher();
    await h.service.tryDispatchNextMessage('s');
    expect(h.send).toHaveBeenCalledExactlyOnceWith('s', 'fresh-one\n\nfresh-two');
    expect(domain.getQueueSnapshot('s')).toEqual([held]);
    expect(domain.peekNextMessage('s')).toBe(held);
    expect(h.notificationClaim).not.toHaveBeenCalledWith('s', held.id);
    expect(h.background.prepare).not.toHaveBeenCalled();
    expect(
      await db.prisma.promptDispatchAttempt.findUniqueOrThrow({ where: { id: uncertainId! } })
    ).toEqual(proof);
    expect(await db.prisma.workspaceNotification.findMany({ orderBy: { id: 'asc' } })).toEqual(
      notificationProof
    );
    expect((await intents.store.find('s', 'old-human'))?.status).toBe('uncertain');
    expect(await intents.store.hasUncertainAttempt('s')).toBe(true);
    await h.service.tryDispatchNextMessage('s');
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(domain.getQueueSnapshot('s')).toEqual([held]);
  }
);
