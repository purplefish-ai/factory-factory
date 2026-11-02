import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ChatIntentAccessor } from '@/backend/services/session/resources/chat-intent.accessor';
import { AcpClientFactory } from '@/backend/services/session/service/acp/acp-client-factory';
import { PromptNotInvokedError } from '@/backend/services/session/service/acp/acp-prompt-invocation';
import { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import {
  createTestProcessHandle,
  createDeferred,
  defaultOptions,
  defaultHandlers,
  defaultContext,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { SessionDispatchService } from '@/backend/services/session/service/dispatch/session-dispatch.service';
import type { SessionDispatchDependencies } from '@/backend/services/session/service/dispatch/session-dispatch.types';
import { prepareDurableAttempt } from '@/backend/services/session/service/dispatch/session-durable-attempt';
import {
  setupAuthority,
  configOptions,
} from '@/backend/services/session/service/lifecycle/session-config-authority.test-helpers';
import { SessionConfigMutationQueue } from '@/backend/services/session/service/lifecycle/session-config-mutation-queue';
import {
  SessionDomainService,
  sessionDomainService as domain,
} from '@/backend/services/session/service/session-domain.service';
import {
  createIntegrationDatabase,
  clearIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { UncertainChatDispatchError } from './chat-intent-errors';
import { createQueueMessageHandler } from './chat-message-handlers/handlers/queue-message.handler';
import { createRemoveQueuedMessageHandler } from './chat-message-handlers/handlers/remove-queued-message.handler';
import { SessionChatIntentService } from './session-chat-intent.service';
import { SessionLoadService } from './session-load.service';

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
  return { service, send, configured, background, start };
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
it.each(['conflict', ''])(
  'rejects conflicting retries (%s) to the requester without rejecting original accepted input',
  async (text) => {
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
    const conflict = await handler(context, { type: 'queue_message', id: 'human', text });
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
  }
);
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

it('refuses cancellation of selected input without failing any member of the unsent batch', async () => {
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
  const remove = createRemoveQueuedMessageHandler({ domain, chatIntent: intents });
  const result = await remove(
    { sessionId: 's', workingDir: '/tmp' },
    { type: 'remove_queued_message', messageId: 'one' }
  );
  expect(result.replies).toEqual([{ type: 'error', error: { kind: 'message_not_queued' } }]);
  release();
  await dispatch;
  expect(h.send).toHaveBeenCalledExactlyOnceWith('s', 'one\n\ntwo');
  expect((await intents.store.read('s')).map((row) => row.status)).toEqual([
    'committed',
    'committed',
  ]);
});
it('compares immutable payloads on sequential initial retries after desired settings change', async () => {
  const original = message('initial', 'original task');
  await intents.acceptInitial('s', original);
  await intents.override('s', Date.now(), { selectedModel: 'later-model' });
  expect((await intents.acceptInitial('s', original)).message.settings.selectedModel).toBe(
    'later-model'
  );
  await expect(intents.acceptInitial('s', { ...original, text: 'different task' })).rejects.toThrow(
    'different submitted content'
  );
  expect(await db.prisma.chatIntent.count()).toBe(1);
});

it('freezes latest accepted desired revisions and actual provider settings across a delayed claim and later pending edit', async () => {
  await db.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'w',
      provider: 'CODEX',
      providerSessionId: 'thread',
      workflow: 'implement',
      model: 'first',
    },
  });
  const beforeFreeze = createDeferred<void>();
  const enteredConfig = createDeferred<void>();
  const claiming = createDeferred<void>();
  const enteredClaim = createDeferred<void>();
  const response = createDeferred<{ stopReason: 'end_turn' }>();
  let nativeModel = 'first';
  const providerModels: string[] = [];
  const handle = createTestProcessHandle({
    provider: 'CODEX',
    providerSessionId: 'thread',
    connection: {
      setSessionConfigOption: vi.fn(async ({ configId, value }) => {
        if (configId === 'model') {
          if (value === 'second') {
            enteredConfig.resolve();
            await beforeFreeze.promise;
          }
          nativeModel = String(value);
        }
        return { configOptions: configOptions(nativeModel) };
      }),
      prompt: vi.fn(() => {
        providerModels.push(nativeModel);
        return response.promise;
      }),
    },
  });
  Reflect.set(handle.child, 'pid', undefined);
  handle.configOptions = configOptions('first');
  const manager = new AcpRuntimeManager();
  vi.spyOn(AcpClientFactory.prototype, 'createClient').mockResolvedValue(handle);
  await manager.getOrCreateClient(
    'session',
    { ...defaultOptions(), provider: 'CODEX' },
    defaultHandlers(),
    defaultContext()
  );
  const config = setupAuthority(manager, intents).service;
  const queued = { ...message('one'), settings: { ...settings, selectedModel: 'first' } };
  await intents.accept('session', queued);
  const earlyEdit = config.setSessionConfigOption('session', 'model', 'second');
  await enteredConfig.promise;
  const originalClaim = intents.store.claim.bind(intents.store);
  vi.spyOn(intents.store, 'claim').mockImplementationOnce(async (...args) => {
    enteredClaim.resolve();
    await claiming.promise;
    return originalClaim(...args);
  });
  const h = dispatcher(
    (id, content, guard, permit) => {
      if (typeof content !== 'string') {
        throw new Error('Expected text');
      }
      return manager
        .sendPrompt(id, [{ type: 'text', text: content }], undefined, undefined, guard, permit)
        .then(() => undefined);
    },
    { runtimeManager: manager, configService: config, client: handle }
  );
  const sending = h.service.tryDispatchNextMessage('session');
  beforeFreeze.resolve();
  await earlyEdit;
  await enteredClaim.promise;
  let lateAccepted = false;
  const lateEdit = config.setSessionConfigOption('session', 'model', 'third').then(() => {
    lateAccepted = true;
  });
  expect(handle.pendingConfigUpdates).toBeDefined();
  claiming.resolve();
  await vi.waitFor(() => expect(providerModels).toEqual(['second']));
  const attempt = await db.prisma.promptDispatchAttempt.findFirstOrThrow({
    where: { sessionId: 'session' },
  });
  expect(attempt.effectiveSettings).toMatchObject({ selectedModel: 'second' });
  expect(attempt.members).toEqual([expect.objectContaining({ messageId: 'one', revision: 1 })]);
  expect(attempt.providerIdentity).toMatchObject({
    providerSessionId: 'thread',
    nativeConfigOptions: expect.arrayContaining([
      expect.objectContaining({ id: 'model', currentValue: 'second' }),
    ]),
  });
  expect(lateAccepted).toBe(false);
  response.resolve({ stopReason: 'end_turn' });
  await Promise.all([sending, lateEdit]);
  expect(nativeModel).toBe('third');
  expect((await intents.store.read('session'))[0]?.status).toBe('committed');
  handle.child.emit('close', 0, null);
});
it('retries a pre-invocation desired-revision conflict without failing another human member', async () => {
  await intents.accept('s', message('one'));
  await intents.accept('s', message('two'));
  const claim = intents.claim.bind(intents);
  vi.spyOn(intents, 'claim').mockImplementationOnce(async (...args) => {
    await intents.override('s', Date.now(), { selectedModel: 'newest' });
    return claim(...args);
  });
  const h = dispatcher();
  await h.service.tryDispatchNextMessage('s');
  expect(h.send).toHaveBeenCalledExactlyOnceWith('s', 'one\n\ntwo');
  expect((await intents.store.read('s')).map((row) => row.status)).toEqual([
    'committed',
    'committed',
  ]);
  expect(await db.prisma.promptDispatchAttempt.count()).toBe(1);
  expect(
    (await db.prisma.promptDispatchAttempt.findFirstOrThrow()).effectiveSettings
  ).toMatchObject({ selectedModel: 'newest' });
});

it('loads and dispatches a durable initial prompt after a restart without another submission', async () => {
  await db.prisma.agentSession.update({ where: { id: 's' }, data: { provider: 'CODEX' } });
  const previous = domain.chatIntent;
  try {
    domain.chatIntent = intents;
    await domain.storeInitialMessageDurably('s', 'initial task');
    domain.clearAllSessions();
    intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
    domain.chatIntent = intents;
    const h = dispatcher(undefined, { stopped: true });
    const load = new SessionLoadService({
      findSession: (id) =>
        db.prisma.agentSession.findUnique({ where: { id }, include: { workspace: true } }),
      hydrateProviderHistory: () => Promise.resolve(),
      hydrateLifecycleEvents: () => Promise.resolve(),
      hydrateChatIntent: async (id) => {
        await intents.hydrate(id);
        return intents.hasQueuedInput(id);
      },
      getRuntimeSnapshot: (id) => domain.getRuntimeSnapshot(id),
      domain,
      config: {
        getSessionConfigProjection: () =>
          Promise.resolve({
            currentProjection: () => ({
              capabilities: EMPTY_CHAT_BAR_CAPABILITIES,
              configOptions: [],
            }),
          }),
      },
      getCachedCommands: () => Promise.resolve([]),
      tryDispatchNextMessage: (id) => h.service.tryDispatchNextMessage(id),
    });
    const prepared = await load.prepareLoad({ sessionId: 's' });
    if (prepared.status !== 'ready') {
      throw new Error('Expected ready load');
    }
    expect(load.captureReplay(prepared).sessionRuntime.processState).toBe('stopped');
    await load.completeLoad(prepared);
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledExactlyOnceWith('s', 'initial task');
    expect((await intents.store.read('s'))[0]?.status).toBe('committed');
  } finally {
    domain.chatIntent = previous;
  }
});

it('keeps a claimed mixed batch uncertain when stop retires configuration before the provider result', async () => {
  await db.prisma.agentSession.update({
    where: { id: 's' },
    data: { provider: 'CODEX', providerSessionId: 'thread' },
  });
  const handle = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'thread' });
  handle.configOptions = configOptions('first');
  const queue = new SessionConfigMutationQueue(
    { getClient: () => handle, isStopInProgress: () => false },
    vi.fn()
  );
  await intents.accept('s', {
    ...message('human'),
    settings: { ...settings, selectedModel: 'first' },
  });
  domain.enqueue('s', {
    ...message('pr-event-bg', 'background'),
    source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'pr', bindingRevision: 1 } },
  });
  const response = createDeferred<void>();
  const send = vi.fn(() => response.promise);
  const h = dispatcher(send, {
    configService: {
      configureQueuedMessage: (_id, msg) => Promise.resolve(msg.settings),
      resolveQueuedMessageSettings: (_id, msg) => msg.settings,
      withPromptConfiguration: (id, operation, guard) =>
        queue.runPrompt(
          id,
          (permit) => operation({ permit, configure: (msg) => Promise.resolve(msg.settings) }),
          guard
        ),
    },
  });
  h.background.prepare.mockResolvedValue({ status: 'ready' } as never);
  const dispatch = h.service.tryDispatchNextMessage('s');
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  handle.failConfiguration(new Error('runtime stopped before response'));
  await dispatch;
  expect((await intents.store.read('s'))[0]?.status).toBe('uncertain');
  expect(h.background.fail).not.toHaveBeenCalled();
  expect(h.background.complete).not.toHaveBeenCalled();
  response.resolve();
  await vi.waitFor(() => expect(h.background.complete).toHaveBeenCalledOnce());
});

it('preserves definitive pre-invocation settlement instead of classifying a fenced claim as uncertain', async () => {
  const msg = message('one');
  await intents.accept('s', msg);
  const release = intents.holdProjection('s', [msg]);
  const fence = new Error('fenced before invoking provider');
  const attempt = await prepareDurableAttempt({
    owner: intents,
    sessionId: 's',
    messages: [msg],
    content: 'one',
    settings,
    generation: 1,
    isCurrent: () => true,
    guard: { check: () => Promise.reject(fence) },
  });
  const send = vi.fn();
  const error = await attempt.invoke(send).catch((failure: unknown) => failure);
  expect(intents.protectClaimedBatchFailure('s', [msg], error)).not.toBeInstanceOf(
    UncertainChatDispatchError
  );
  expect((await intents.store.read('s'))[0]?.status).toBe('queued');
  expect(send).not.toHaveBeenCalled();
  release?.();
});

it('releases a whole claim only with explicit proof that a local send rejection never entered the provider', async () => {
  const msg = message('one');
  await intents.accept('s', msg);
  const release = intents.holdProjection('s', [msg]);
  const attempt = await prepareDurableAttempt({
    owner: intents,
    sessionId: 's',
    messages: [msg],
    content: 'one',
    settings,
    generation: 1,
    isCurrent: () => true,
  });
  const rejection = new PromptNotInvokedError(new Error('authority rejected before RPC'));
  const error = await attempt
    .invoke(() => Promise.reject(rejection))
    .catch((failure: unknown) => failure);
  expect(error).toBe(rejection);
  expect((await intents.store.read('s'))[0]?.status).toBe('queued');
  expect(intents.protectClaimedBatchFailure('s', [msg], error)).toBe(rejection);
  release?.();
});

it('recovers the original trusted initial submission before rebuilding mutable provisioning input', async () => {
  domain.chatIntent = intents;
  await intents.acceptInitial('s', message('auto-init-s', 'original linked issue'));
  domain.clearAllSessions();
  const recovered = await domain.recoverInitialMessageDurably('s', 'auto-init-s');
  expect(recovered?.text).toBe('original linked issue');
  expect(domain.getQueueSnapshot('s').map((row) => row.text)).toEqual(['original linked issue']);
});

it('does not requeue a confirmed-unsent mixed batch when stop occurs while releasing external claims', async () => {
  await intents.accept('s', message('one'));
  domain.enqueue('s', {
    ...message('pr-event-held'),
    source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'pr', bindingRevision: 1 } },
  });
  let current = true;
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const h = dispatcher(() => Promise.reject(new PromptNotInvokedError(new Error('before RPC'))), {
    isCurrent: () => current,
  });
  h.background.prepare.mockResolvedValue({ status: 'ready' } as never);
  h.background.fail.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const dispatch = h.service.tryDispatchNextMessage('s');
  await entered.promise;
  current = false;
  await intents.cancel('s');
  domain.clearQueuedWork('s');
  release.resolve();
  await dispatch;
  expect(domain.getQueueLength('s')).toBe(0);
  expect((await intents.store.read('s'))[0]?.status).toBe('cancelled');
});
