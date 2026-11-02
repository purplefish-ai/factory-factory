import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  clearIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { ChatIntentAccessor } from '../../resources/chat-intent.accessor';
import { sessionDataService } from '../data/session-data.service';
import { SessionDispatchService } from '../dispatch/session-dispatch.service';
import type { SessionDispatchDependencies } from '../dispatch/session-dispatch.types';
import { SessionDomainService, sessionDomainService as domain } from '../session-domain.service';
import { createQueueMessageHandler } from './chat-message-handlers/handlers/queue-message.handler';
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
    isCurrent?: () => boolean;
    steer?: SessionDispatchDependencies['promptService']['steerSessionMessage'];
  } = {}
) {
  const background = {
    prepare: vi.fn(),
    validate: vi.fn(async () => true),
    fail: vi.fn(),
    complete: vi.fn(),
  };
  const configured = vi.fn(async (_id: string, msg: QueuedMessage) => msg.settings);
  const service = new SessionDispatchService({
    chatIntent: intents,
    runtimeManager: {
      isSessionPromptInFlight: () => options.promptInFlight ?? false,
      isSessionRunning: () => true,
    },
    configService: {
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
    startup: { getSessionClient: () => ({}), getOrCreateSessionClient: () => Promise.resolve({}) },
    notificationDelivery: {
      claimForDispatch: () => ({ status: 'not_notification' }),
      isAlreadyDelivered: async () => false,
      acknowledgeSuccessfulDispatch: vi.fn(),
      recoverPending: vi.fn(),
      removeDuplicateFromQueue: () => false,
      resetSession: vi.fn(),
      isNotificationMessage: (id) => id.startsWith('workspace-notification-'),
    },
  });
  vi.spyOn(sessionDataService, 'findAgentSessionById').mockResolvedValue({
    workspace: { status: 'READY' },
  } as never);
  return { service, send, configured, background };
}
it('persists accepted payload before acknowledgment and deduplicates concurrent handler retries', async () => {
  const emit = vi.spyOn(domain, 'emitDelta');
  const handler = createQueueMessageHandler({
    domain,
    chatIntent: intents,
    backgroundDelivery: { captureResumeGuard: () => () => true, userResume: async () => undefined },
    tryDispatchNextMessage: async () => undefined,
  });
  await Promise.all(
    Array.from({ length: 5 }, () =>
      handler(
        { sessionId: 's', workingDir: '/tmp' },
        {
          type: 'queue_message',
          id: 'human',
          text: 'hello',
          attachments: [
            {
              id: 'a',
              name: 'text.txt',
              type: 'text/plain',
              contentType: 'text',
              size: 5,
              data: 'bytes',
            },
          ],
        }
      )
    )
  );
  expect(await db.prisma.chatIntent.count()).toBe(1);
  expect(domain.getQueueSnapshot('s')).toHaveLength(1);
  expect(emit).toHaveBeenCalledWith('s', expect.objectContaining({ newState: 'ACCEPTED' }));
  const restarted = new SessionDomainService();
  await new SessionChatIntentService(new ChatIntentAccessor(db.prisma), restarted).hydrate('s');
  expect(restarted.getQueueSnapshot('s')[0]?.attachments?.[0]?.data).toBe('bytes');
});
it('dispatches one batched prompt with the last human settings and later overrides after restart', async () => {
  await intents.accept('s', message('one', 'first'));
  await intents.accept('s', {
    ...message('two', 'second'),
    settings: { ...settings, selectedModel: 'opus', planModeEnabled: true },
  });
  await intents.override('s', Date.now(), { reasoningEffort: 'high', planModeEnabled: false });
  domain.clearAllSessions();
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  const h = dispatcher();
  await h.service.tryDispatchNextMessage('s');
  expect(h.send).toHaveBeenCalledExactlyOnceWith('s', 'first\n\nsecond');
  expect(h.configured).toHaveBeenCalledWith(
    's',
    expect.objectContaining({
      id: 'two',
      settings: expect.objectContaining({
        selectedModel: 'opus',
        reasoningEffort: 'high',
        planModeEnabled: false,
      }),
    }),
    false
  );
  expect((await intents.store.read('s')).map((r) => r.status)).toEqual(['committed', 'committed']);
  expect(await db.prisma.promptDispatchAttempt.count()).toBe(1);
});
it('a crash after durable claim but before invocation recovers the whole batch as uncertain without sending', async () => {
  await intents.accept('s', message('one'));
  await intents.accept('s', message('two'));
  await intents.claim('s', domain.getQueueSnapshot('s'), 'one\n\ntwo', settings, 1);
  domain.clearAllSessions();
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  const h = dispatcher();
  const failed = vi.spyOn(domain, 'failMessage');
  await h.service.tryDispatchNextMessage('s');
  expect(h.send).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledTimes(2);
  expect(domain.getQueueLength('s')).toBe(0);
});
it('a lost provider result preserves one uncertain attempt and identical retries never resend', async () => {
  await intents.accept('s', message('one'));
  await intents.accept('s', message('two'));
  const send = vi.fn(async () => {
    expect(await db.prisma.promptDispatchAttempt.count({ where: { status: 'uncertain' } })).toBe(1);
    expect((await intents.store.read('s')).every((row) => row.status === 'uncertain')).toBe(true);
    throw new Error('lost provider result');
  });
  await dispatcher(send).service.tryDispatchNextMessage('s');
  expect(send).toHaveBeenCalledTimes(1);
  expect((await intents.store.read('s')).map((r) => r.status)).toEqual(['uncertain', 'uncertain']);
  await intents.accept('s', message('one'));
  domain.clearAllSessions();
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  await dispatcher(send).service.tryDispatchNextMessage('s');
  expect(send).toHaveBeenCalledTimes(1);
});
it('cancellation and stale acceptance guards cannot revive work on restart', async () => {
  await intents.accept('s', message('stopped'), () => false);
  await intents.accept('s', message('cancelled'));
  await intents.cancel('s', 'cancelled');
  domain.clearAllSessions();
  await new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain).hydrate('s');
  expect(domain.getQueueLength('s')).toBe(0);
});

it('retains full mixed membership and never releases or resends an ambiguous external effect', async () => {
  await intents.accept('s', message('one'));
  const background = {
    ...message('pr-event-bg', 'background'),
    source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'pr', bindingRevision: 1 } },
  } as const;
  domain.enqueue('s', background);
  const h = dispatcher(vi.fn(() => Promise.reject(new Error('lost result'))));
  h.background.prepare.mockResolvedValue({ status: 'ready' } as never);
  await h.service.tryDispatchNextMessage('s');
  expect(h.send).toHaveBeenCalledExactlyOnceWith('s', 'one\n\nbackground');
  expect(h.background.fail).not.toHaveBeenCalled();
  expect(h.background.complete).not.toHaveBeenCalled();
  const attempt = await db.prisma.promptDispatchAttempt.findFirstOrThrow();
  expect(attempt.members).toEqual([
    expect.objectContaining({ messageId: 'one', owner: 'human' }),
    expect.objectContaining({ messageId: background.id, owner: 'external' }),
  ]);
  domain.clearAllSessions();
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  domain.enqueue('s', background);
  const restarted = dispatcher(h.send);
  await restarted.service.tryDispatchNextMessage('s');
  expect(h.send).toHaveBeenCalledTimes(1);
  await expect(intents.store.resolve('s', attempt.id, 'committed')).rejects.toThrow(
    'external delivery owner'
  );
});
it('rejects conflicting retries to the requester without rejecting the original accepted message', async () => {
  const handler = createQueueMessageHandler({
    domain,
    chatIntent: intents,
    backgroundDelivery: {
      captureResumeGuard: () => () => true,
      userResume: () => Promise.resolve(),
    },
    tryDispatchNextMessage: () => Promise.resolve(),
  });
  const emit = vi.spyOn(domain, 'emitDelta');
  const context = { sessionId: 's', workingDir: '/tmp' };
  await handler(context, { type: 'queue_message', id: 'human', text: 'original' });
  const conflict = await handler(context, { type: 'queue_message', id: 'human', text: 'conflict' });
  expect(conflict.replies).toEqual([
    {
      type: 'error',
      error: {
        kind: 'queue_input_invalid',
        reason: 'Message id already accepted with different submitted content',
      },
    },
  ]);
  expect(emit).not.toHaveBeenCalledWith('s', expect.objectContaining({ newState: 'REJECTED' }));
  expect(domain.getQueueSnapshot('s').map((m) => m.text)).toEqual(['original']);
});
it('does not rehydrate or retry a selected batch while provider configuration is awaiting', async () => {
  await intents.accept('s', message('one'));
  await intents.accept('s', message('two'));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = dispatcher();
  h.configured.mockImplementationOnce(async () => {
    await waiting;
    return settings;
  });
  const dispatch = h.service.tryDispatchNextMessage('s');
  await vi.waitFor(() => expect(h.configured).toHaveBeenCalled());
  try {
    await intents.hydrate('s');
    await intents.accept('s', message('one'));
    expect(domain.getQueueSnapshot('s')).toHaveLength(0);
  } finally {
    release();
    await dispatch;
  }
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(domain.getQueueSnapshot('s')).toHaveLength(0);
});

it('a late steering promptRequired result cannot revive input after stop advances the generation', async () => {
  await intents.accept('s', message('human'));
  let complete!: (result: { outcome: 'promptRequired' }) => void;
  const waiting = new Promise<{ outcome: 'promptRequired' }>((resolve) => {
    complete = resolve;
  });
  let current = true;
  const steer = vi.fn(() => waiting);
  const h = dispatcher(undefined, { promptInFlight: true, isCurrent: () => current, steer });
  const steering = h.service.steerQueuedMessage('s', 'human');
  await vi.waitFor(() => expect(steer).toHaveBeenCalled());
  current = false;
  await intents.cancel('s');
  domain.clearQueuedWork('s');
  complete({ outcome: 'promptRequired' });
  await steering;
  domain.clearAllSessions();
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  await intents.hydrate('s');
  expect(domain.getQueueSnapshot('s')).toHaveLength(0);
  expect((await intents.store.read('s'))[0]?.status).toBe('cancelled');
});
it('restores previously accepted humans ahead of a full recovered background queue', async () => {
  await intents.accept('s', message('human'));
  domain.clearAllSessions();
  for (let index = 0; index < 100; index += 1) {
    domain.enqueue('s', {
      ...message(`pr-event-${index}`),
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'pr', bindingRevision: 1 } },
    });
  }
  await new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain).hydrate('s');
  expect(domain.peekNextMessage('s')?.id).toBe('human');
  expect(domain.getQueueSnapshot('s')).toHaveLength(101);
});
it('a successful send with failed durable settlement remains uncertain and cannot replay after restart', async () => {
  await intents.accept('s', message('human'));
  vi.spyOn(intents.store, 'settle').mockRejectedValueOnce(
    new Error('database unavailable after provider completion')
  );
  const h = dispatcher();
  await h.service.tryDispatchNextMessage('s');
  expect(h.send).toHaveBeenCalledTimes(1);
  expect((await intents.store.read('s'))[0]?.status).toBe('uncertain');
  domain.clearAllSessions();
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  await dispatcher(h.send).service.tryDispatchNextMessage('s');
  expect(h.send).toHaveBeenCalledTimes(1);
});
it('refuses manual recovery while a batch is live and preserves provider settlement', async () => {
  await intents.accept('s', message('one'));
  await intents.accept('s', message('two'));
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const h = dispatcher(vi.fn(() => waiting));
  const dispatch = h.service.tryDispatchNextMessage('s');
  await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
  const attempt = (await intents.store.listUncertain('s'))[0]!;
  await expect(intents.resolve('s', attempt.id, 'cancelled')).rejects.toThrow('still in flight');
  finish();
  await dispatch;
  expect((await intents.store.read('s')).map((row) => row.status)).toEqual([
    'committed',
    'committed',
  ]);
});
it('keeps an already queued notification out of a newer human batch while prior delivery is uncertain', async () => {
  await intents.accept('s', message('old'));
  await intents.claim('s', [message('old')], 'old', settings, 1);
  domain.clearAllSessions();
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  await intents.accept('s', message('new'));
  domain.enqueue('s', message('workspace-notification-pending', 'external notification'));
  const h = dispatcher();
  await h.service.tryDispatchNextMessage('s');
  expect(h.send).toHaveBeenCalledExactlyOnceWith('s', 'new');
  expect(domain.getQueueSnapshot('s').map((m) => m.id)).toEqual(['workspace-notification-pending']);
});
it('persists deterministic initial human text through store eviction and provisioning retries', async () => {
  const initialDomain = new SessionDomainService();
  initialDomain.chatIntent = new SessionChatIntentService(
    new ChatIntentAccessor(db.prisma),
    initialDomain
  );
  await initialDomain.storeInitialMessageDurably('s', 'initial task');
  initialDomain.clearAllSessions();
  const restarted = new SessionDomainService();
  restarted.chatIntent = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), restarted);
  await restarted.storeInitialMessageDurably('s', 'initial task');
  expect(await db.prisma.chatIntent.count()).toBe(1);
  expect(restarted.getQueueSnapshot('s')).toEqual([
    expect.objectContaining({ id: 'initial-human-s', text: 'initial task' }),
  ]);
});
it('persists permanent attachment rejection so a legacy invalid intent cannot rehydrate forever', async () => {
  const invalid = {
    ...message('bad'),
    attachments: [
      {
        id: 'bad-image',
        name: 'bad.png',
        type: 'image/png',
        size: 5,
        data: 'invalid base64 spaces',
      },
    ],
  };
  await intents.store.accept('s', invalid, false);
  const h = dispatcher();
  await h.service.tryDispatchNextMessage('s');
  expect(h.send).not.toHaveBeenCalled();
  expect((await intents.store.read('s'))[0]?.status).toBe('failed');
  domain.clearAllSessions();
  await new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain).hydrate('s');
  expect(domain.getQueueSnapshot('s')).toEqual([]);
});
