import { randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  pending: vi.fn(),
  claim: vi.fn(),
  recover: vi.fn(),
  session: vi.fn(),
  receipt: vi.fn(),
  busy: vi.fn(),
  interaction: vi.fn(),
  observe: vi.fn(),
  otherReady: vi.fn(),
  pause: vi.fn(),
  cancel: vi.fn(),
  invalidate: vi.fn(),
  enqueue: vi.fn(),
  dispatch: vi.fn(),
  resume: vi.fn(),
  active: vi.fn(),
  settle: vi.fn(),
  emit: vi.fn(),
  dedicated: vi.fn(),
  ensureDedicated: vi.fn(),
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: {
    get: mocks.get,
    listPending: mocks.pending,
    claimDelivery: mocks.claim,
    recoverClaim: mocks.recover,
    pauseWorkspace: mocks.pause,
    pause: mocks.pause,
    resume: mocks.resume,
    cancelRecoveredDelivery: mocks.cancel,
    settleDelivery: mocks.settle,
  },
  workspacePrSnapshotService: {
    find: vi.fn(async () => ({ id: 'p' })),
    list: vi.fn(async () => [{ id: 'p' }]),
  },
}));
vi.mock('@/backend/services/ratchet', () => ({
  ratchetService: { emit: mocks.emit },
  RATCHET_DISPATCH_CHANGED: 'ratchet_dispatch_changed',
}));
vi.mock('@/backend/services/session', () => ({
  acpRuntimeManager: {
    isSessionPromptInFlight: mocks.busy,
    isSessionWorking: () => true,
  },
  sessionDataService: {
    findAgentSessionById: mocks.session,
    findPRDedicatedSession: mocks.dedicated,
  },
  sessionDomainService: { getPendingInteractiveRequest: mocks.interaction },
  sessionLifecycleService: {},
  sessionDispatchService: { tryDispatchNextMessage: mocks.dispatch },
  sessionBackgroundDeliveryService: {
    invalidate: mocks.invalidate,
    enqueue: mocks.enqueue,
    isDeliveryActive: mocks.active,
  },
  findPRDeliveryReceipt: mocks.receipt,
}));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({ ratchetReplyToPrComments: true })) },
}));

vi.mock('./pr-delivery-readiness', () => ({ recipientCanDispatch: mocks.otherReady }));
vi.mock('./pr-observation.orchestrator', () => ({
  observeMonitoredPR: mocks.observe,
}));

vi.mock('./pr-dedicated-session.orchestrator', () => ({
  ensureDedicatedPRRecipient: mocks.ensureDedicated,
}));
import { defaultPRDeliveryPorts } from './pr-delivery-dependencies';
import { recoverPRDeliveries } from './pr-delivery-recovery';
import { prBackgroundDeliveryPort } from './pr-event-delivery-port';
import {
  preparePRDelivery,
  wakePRDelivery,
  guardPRDelivery,
} from './pr-event-delivery.orchestrator';

const config = {
  enabled: true,
  deliveryMode: 'MAIN' as 'MAIN' | 'DEDICATED',
  workspaceId: 'w',
  recipientSessionId: 'main',
  bindingRevision: 1,
  deliveryPauseReason: null as string | null,
};
beforeEach(() => {
  vi.resetAllMocks();
  config.recipientSessionId = 'main';
  config.deliveryMode = 'MAIN';
  config.bindingRevision = 1;
  config.deliveryPauseReason = null;
  mocks.get.mockImplementation(async () => ({ ...config }));
  mocks.session.mockResolvedValue({
    id: 'main',
    workspaceId: 'w',
    workflow: 'implement',
    provider: 'CLAUDE',
    providerSessionId: 'original',
    workspace: { status: 'READY', worktreePath: tmpdir() },
  });
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.find).mockResolvedValue({
    id: 'p',
  } as never);
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.list).mockResolvedValue([
    { id: 'p' },
  ] as never);
  mocks.observe.mockResolvedValue(true);
  mocks.busy.mockReturnValue(false);
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.interaction.mockReturnValue(null);
  mocks.otherReady.mockResolvedValue(true);
  mocks.pause.mockResolvedValue({ count: 1 });
  mocks.recover.mockResolvedValue({ count: 1, status: 'recovered' });
  mocks.pending.mockResolvedValue([
    {
      id: 'event',
      workspaceId: 'w',
      prId: 'p',
      state: 'DISPATCHING',
      deliveryId: 'delivery',
      deliverySessionId: 'main',
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'original',
    },
  ]);
});
it.each(['EACCES', 'EIO', 'ETIMEDOUT', undefined])(
  'blocks transient filesystem error %j without pausing delivery and permits a later retry',
  async (code) => {
    vi.mocked(filesystem.stat).mockRejectedValueOnce(
      Object.assign(new Error('worktree lookup failed'), { code })
    );
    const input = {
      sessionId: 'main',
      request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
    };
    expect(await preparePRDelivery(input)).toMatchObject({ status: 'blocked' });
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(await guardPRDelivery('main', input.request, defaultPRDeliveryPorts)).toBe('ready');
  }
);
it.each(['ENOENT', 'ENOTDIR'])(
  'persists a delivery pause for filesystem error %s',
  async (code) => {
    vi.mocked(filesystem.stat).mockRejectedValueOnce(
      Object.assign(new Error('worktree unavailable'), { code })
    );
    expect(
      await guardPRDelivery(
        'main',
        {
          workspaceId: 'w',
          prId: 'p',
          bindingRevision: 1,
        },
        defaultPRDeliveryPorts
      )
    ).toBe('blocked');
    expect(mocks.pause).toHaveBeenCalledWith('w', 'SESSION_FAILED', 1);
  }
);
it.each([null, join(tmpdir(), `ff-deleted-worktree-${randomUUID()}`)])(
  'pauses delivery before claiming or starting a session when worktree %j is unavailable',
  async (worktreePath) => {
    mocks.session.mockResolvedValue({
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CODEX',
      providerSessionId: 'original',
      workspace: { status: 'READY', worktreePath },
    });
    expect(
      await preparePRDelivery({
        sessionId: 'main',
        request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
      })
    ).toMatchObject({ status: 'blocked' });
    expect(mocks.pause).toHaveBeenCalledWith('w', 'SESSION_FAILED', 1);
    expect(mocks.invalidate).toHaveBeenCalledWith('w', 1);
    expect(mocks.emit).toHaveBeenCalledWith('ratchet_dispatch_changed', { workspaceId: 'w' });
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  }
);
it('does not publish or invalidate a directory pause rejected by the binding fence', async () => {
  mocks.session.mockResolvedValue({
    id: 'main',
    workspaceId: 'w',
    workflow: 'implement',
    provider: 'CODEX',
    providerSessionId: 'original',
    workspace: { status: 'READY', worktreePath: null },
  });
  mocks.pause.mockResolvedValueOnce({ count: 0 });
  expect(
    await guardPRDelivery(
      'main',
      {
        workspaceId: 'w',
        prId: 'p',
        bindingRevision: 1,
      },
      defaultPRDeliveryPorts
    )
  ).toBe('blocked');
  expect(mocks.emit).not.toHaveBeenCalled();
  expect(mocks.invalidate).not.toHaveBeenCalled();
});
it('discards a detached PR request without pausing its workspace for a missing worktree', async () => {
  mocks.session.mockResolvedValue({
    id: 'main',
    workspaceId: 'w',
    workflow: 'implement',
    provider: 'CODEX',
    providerSessionId: 'original',
    workspace: { status: 'READY', worktreePath: null },
  });
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.find).mockResolvedValueOnce(null);
  expect(
    await guardPRDelivery(
      'main',
      {
        workspaceId: 'w',
        prId: 'detached',
        bindingRevision: 1,
      },
      defaultPRDeliveryPorts
    )
  ).toBe('discard');
  expect(mocks.pause).not.toHaveBeenCalled();
});
it('queues for the next turn without claiming while the recipient is busy', async () => {
  mocks.busy.mockReturnValue(true);
  expect(
    await preparePRDelivery({
      sessionId: 'main',
      request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
    })
  ).toMatchObject({ status: 'blocked' });
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('rejects a binding stopped while observation refresh is in flight', async () => {
  mocks.pending.mockResolvedValue([queuedFact('p')]);
  mocks.observe.mockImplementation(() => {
    config.bindingRevision++;
    config.deliveryPauseReason = 'USER_STOPPED';
  });
  expect(
    await preparePRDelivery({
      sessionId: 'main',
      request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
    })
  ).toEqual({ status: 'discard' });
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('does not acknowledge an optimistic local message', async () => {
  mocks.receipt.mockResolvedValue('unavailable');
  await recoverPRDeliveries('main');
  expect(mocks.recover).not.toHaveBeenCalled();
  mocks.receipt.mockResolvedValue('delivered');
  await recoverPRDeliveries('main');
  expect(mocks.recover).toHaveBeenCalledWith('delivery', true);
});
it('rechecks the binding after the asynchronous final recipient guard', async () => {
  mocks.otherReady.mockImplementation(() => {
    config.bindingRevision++;
    return true;
  });
  expect(
    await prBackgroundDeliveryPort.validate({
      deliveryId: 'delivery',
      sessionId: 'main',
      bindingRevision: 1,
      eventIds: ['event'],
      text: 'frozen',
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'original',
      attempt: 1,
    })
  ).toBe(false);
});

it('recovers frozen claims in the old recipient before waking a new recipient', async () => {
  config.recipientSessionId = 'new-main';
  mocks.receipt.mockResolvedValue('delivered');
  await recoverPRDeliveries('main');
  expect(mocks.recover).toHaveBeenCalledWith('delivery', true);
  config.recipientSessionId = 'main';
  config.deliveryMode = 'MAIN';
});
it('cancels an old frozen delivery only after provider history proves absence', async () => {
  config.recipientSessionId = 'new-main';
  mocks.receipt.mockResolvedValue('absent');
  await recoverPRDeliveries('main');
  expect(mocks.cancel).toHaveBeenCalledWith('delivery', 'main');
  config.recipientSessionId = 'main';
  config.deliveryMode = 'MAIN';
});
it('rechecks another working session in the final dispatch guard', async () => {
  mocks.otherReady.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(
    await prBackgroundDeliveryPort.validate({
      deliveryId: 'delivery',
      sessionId: 'main',
      bindingRevision: 1,
      eventIds: ['event'],
      text: 'frozen',
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'original',
      attempt: 1,
    })
  ).toBe(false);
});
it('forces a fresh observation before freezing a PR update', async () => {
  mocks.pending.mockResolvedValue([queuedFact('p')]);
  await preparePRDelivery({
    sessionId: 'main',
    request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
  });
  expect(mocks.observe).toHaveBeenCalledWith(
    expect.objectContaining({ cacheScope: expect.anything() }),
    { workspaceId: 'w', prId: 'p' },
    { force: true }
  );
});
it('reads candidate facts before refresh and rechecks authorization before claiming', async () => {
  mocks.pending.mockResolvedValue([queuedFact('p')]);
  const refreshObservation = vi.fn(() => {
    config.bindingRevision++;
    return Promise.resolve(true);
  });
  const services = { ...defaultPRDeliveryPorts, refreshObservation };
  expect(
    await preparePRDelivery(
      {
        sessionId: 'main',
        request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
      },
      services
    )
  ).toEqual({ status: 'discard' });
  expect(refreshObservation).toHaveBeenCalledWith({ workspaceId: 'w', prId: 'p' });
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(mocks.pending).toHaveBeenCalledTimes(2);
  expect(mocks.pending.mock.invocationCallOrder[0]).toBeLessThan(
    refreshObservation.mock.invocationCallOrder[0]!
  );
  expect(mocks.pending.mock.invocationCallOrder[1]).toBeGreaterThan(
    refreshObservation.mock.invocationCallOrder[0]!
  );
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('does not freeze or claim events when the injected refresh fails', async () => {
  mocks.pending.mockResolvedValue([queuedFact('p')]);
  const refreshObservation = vi.fn(() => Promise.reject(new Error('GitHub unavailable')));
  await expect(
    preparePRDelivery(
      {
        sessionId: 'main',
        request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
      },
      { ...defaultPRDeliveryPorts, refreshObservation }
    )
  ).resolves.toMatchObject({ status: 'blocked', reason: 'Waiting for fresh PR observations' });
  expect(mocks.pending).toHaveBeenCalledTimes(2);
  expect(mocks.pause).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('does not invalidate the bound recipient when an unrelated session stops', async () => {
  config.recipientSessionId = 'different-main';
  await prBackgroundDeliveryPort.pause('main', 'USER_STOPPED');
  expect(mocks.invalidate).not.toHaveBeenCalled();
  config.recipientSessionId = 'main';
  config.deliveryMode = 'MAIN';
});

it('rejects a frozen retry after provider conversation identity changes', async () => {
  mocks.pending.mockResolvedValue([
    {
      id: 'event',
      workspaceId: 'w',
      prId: 'p',
      state: 'PENDING',
      deliveryId: 'delivery',
      deliverySessionId: 'main',
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'old-conversation',
    },
  ]);
  expect(
    await preparePRDelivery({
      sessionId: 'main',
      request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
    })
  ).toMatchObject({ status: 'blocked' });
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(mocks.pause).toHaveBeenCalledWith('w', 'RECEIPT_UNAVAILABLE', 1);
});
it('revalidates the frozen provider conversation after startup', async () => {
  expect(
    await prBackgroundDeliveryPort.validate({
      deliveryId: 'delivery',
      sessionId: 'main',
      bindingRevision: 1,
      eventIds: ['event'],
      text: 'frozen',
      attempt: 1,
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'old-conversation',
    })
  ).toBe(false);
});

it('allows delivery while background work keeps the recipient active', async () => {
  expect(
    await guardPRDelivery(
      'main',
      {
        workspaceId: 'w',
        prId: 'p',
        bindingRevision: 1,
      },
      defaultPRDeliveryPorts
    )
  ).toBe('ready');
});

it('recovers an absent receipt while unrelated background activity continues', async () => {
  mocks.receipt.mockResolvedValue('absent');
  await recoverPRDeliveries('main');
  expect(mocks.recover).toHaveBeenCalledWith('delivery', false, {
    sessionId: 'main',
    provider: 'CLAUDE',
    providerSessionId: 'original',
  });
});

it('keeps automated PR work queued for an unanswered interaction without an active prompt', async () => {
  mocks.interaction.mockReturnValue({ requestId: 'approval', type: 'permission' });
  expect(
    await guardPRDelivery(
      'main',
      {
        workspaceId: 'w',
        prId: 'p',
        bindingRevision: 1,
      },
      defaultPRDeliveryPorts
    )
  ).toBe('blocked');
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('does not reset a claim if a provider turn starts during receipt lookup', async () => {
  mocks.receipt.mockImplementation(() => {
    mocks.busy.mockReturnValue(true);
    return Promise.resolve('absent');
  });
  await recoverPRDeliveries('main');
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(mocks.cancel).not.toHaveBeenCalled();
});

it('re-enqueues durable pending events under the resumed binding revision', async () => {
  config.deliveryPauseReason = 'USER_STOPPED';
  mocks.resume.mockImplementation(() => {
    config.bindingRevision = 2;
    config.deliveryPauseReason = null;
    return Promise.resolve();
  });
  mocks.receipt.mockResolvedValue('absent');
  await prBackgroundDeliveryPort.resume('main');
  expect(mocks.invalidate).toHaveBeenCalledWith('w', 1);
  expect(mocks.enqueue).toHaveBeenCalledWith('main', {
    workspaceId: 'w',
    prId: 'p',
    bindingRevision: 2,
  });
  expect(mocks.dispatch).toHaveBeenCalledWith('main');
});
it('keeps an active source claim fenced while its cold runtime is starting', async () => {
  mocks.active.mockReturnValue(true);
  await recoverPRDeliveries('main');
  expect(mocks.receipt).not.toHaveBeenCalled();
  expect(mocks.recover).not.toHaveBeenCalled();
});

it.each([1, 0])(
  'publishes a failed delivery pause only when its fence applies (count %s)',
  async (count) => {
    mocks.pause.mockResolvedValue({ count });
    const outcome = await prBackgroundDeliveryPort.fail(
      {
        deliveryId: 'delivery',
        sessionId: 'main',
        bindingRevision: 1,
        eventIds: ['event'],
        text: 'frozen',
        attempt: 3,
      },
      new Error('transport failure')
    );
    expect(outcome).toEqual({ paused: count > 0 });
    expect(mocks.pause).toHaveBeenCalledWith('w', 'DELIVERY_FAILED', 1);
    expect(mocks.emit.mock.calls).toEqual(
      count ? [['ratchet_dispatch_changed', { workspaceId: 'w' }]] : []
    );
  }
);

it('keeps a newer user stop fenced when resume becomes stale during a binding read', async () => {
  let current = true;
  mocks.get.mockImplementation(() => {
    current = false;
    return Promise.resolve({ ...config, deliveryPauseReason: 'USER_STOPPED' });
  });
  await prBackgroundDeliveryPort.resume('main', () => current);
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it('does not enqueue resumed PR updates when a stop arrives during the wake read', async () => {
  let current = true;
  mocks.pending.mockImplementation(() => {
    current = false;
    return Promise.resolve([{ id: 'event', workspaceId: 'w', prId: 'p', state: 'PENDING' }]);
  });
  await prBackgroundDeliveryPort.resume('main', () => current);
  expect(mocks.resume).toHaveBeenCalledWith('main', expect.any(Function));
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it('routes each PR to its reusable dedicated conversation without main controls', async () => {
  config.deliveryMode = 'DEDICATED';
  mocks.pending.mockResolvedValue([
    { id: 'e1', prId: 'p' },
    { id: 'e2', prId: 'q' },
  ]);
  mocks.ensureDedicated.mockImplementation(async ({ prId }) => ({ id: `dedicated-${prId}` }));
  await wakePRDelivery('w');
  expect(mocks.enqueue).toHaveBeenCalledWith('dedicated-p', {
    workspaceId: 'w',
    prId: 'p',
    bindingRevision: 1,
    deliveryMode: 'DEDICATED',
  });
  expect(mocks.enqueue).toHaveBeenCalledWith('dedicated-q', {
    workspaceId: 'w',
    prId: 'q',
    bindingRevision: 1,
    deliveryMode: 'DEDICATED',
  });
  expect(mocks.dispatch).not.toHaveBeenCalledWith('main');
});
it('rejects dedicated delivery to the conversation bound to a different PR', async () => {
  config.deliveryMode = 'DEDICATED';
  mocks.session.mockResolvedValue({
    id: 'dedicated',
    workspaceId: 'w',
    workspacePrId: 'q',
    workflow: 'pr-monitoring',
    workspace: { status: 'READY', worktreePath: tmpdir() },
  });
  mocks.dedicated.mockResolvedValue(null);
  expect(
    await guardPRDelivery(
      'dedicated',
      { workspaceId: 'w', prId: 'p', bindingRevision: 1, deliveryMode: 'DEDICATED' },
      defaultPRDeliveryPorts
    )
  ).toBe('discard');
});
it('keeps a proven-absent frozen claim for its still-bound dedicated recipient', async () => {
  config.deliveryMode = 'DEDICATED';
  config.recipientSessionId = 'preferred-main';
  mocks.session.mockResolvedValue({
    id: 'main',
    workspaceId: 'w',
    workspacePrId: 'p',
    workflow: 'pr-monitoring',
  });
  mocks.dedicated.mockResolvedValue({
    id: 'main',
    workspaceId: 'w',
    workspacePrId: 'p',
    workflow: 'pr-monitoring',
  });
  mocks.receipt.mockResolvedValue('absent');
  await recoverPRDeliveries('main');
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(mocks.recover).toHaveBeenCalledWith('delivery', false);
});
it('does not enqueue a dedicated recipient after the mode changes during creation', async () => {
  config.deliveryMode = 'DEDICATED';
  mocks.pending.mockResolvedValue([{ id: 'e1', prId: 'p' }]);
  mocks.ensureDedicated.mockImplementation(() => {
    config.deliveryMode = 'MAIN';
    config.bindingRevision++;
    return Promise.resolve({ id: 'dedicated' });
  });
  await wakePRDelivery('w');
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it('retains an authorized queue request when a concurrent workspace claim wins', async () => {
  mocks.pending.mockResolvedValue([
    { id: 'event', prId: 'p', state: 'PENDING', deliveryText: 'frozen text', attempts: 0 },
  ]);
  mocks.claim.mockResolvedValue(null);
  expect(
    await preparePRDelivery({
      sessionId: 'main',
      request: {
        workspaceId: 'w',
        prId: 'p',
        bindingRevision: 1,
      },
    })
  ).toMatchObject({ status: 'blocked' });
  expect(mocks.claim).toHaveBeenCalledOnce();
});

it('wakes sibling PR requests as soon as a completed claim settles', async () => {
  mocks.pending.mockResolvedValue([{ id: 'event-q', prId: 'q', state: 'PENDING' }]);
  await prBackgroundDeliveryPort.complete({
    deliveryId: 'done',
    sessionId: 'main',
    bindingRevision: 1,
    eventIds: ['event-p'],
    text: 'done',
    attempt: 1,
  });
  expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ result: 'delivered' }));
  expect(mocks.enqueue).toHaveBeenCalledWith('main', {
    workspaceId: 'w',
    prId: 'q',
    bindingRevision: 1,
  });
  expect(mocks.dispatch).toHaveBeenCalledWith('main');
});

it('keeps a delivered claim settled when waking its sibling fails', async () => {
  mocks.pending.mockRejectedValue(new Error('wake read unavailable'));
  await expect(
    prBackgroundDeliveryPort.complete({
      deliveryId: 'done',
      sessionId: 'main',
      bindingRevision: 1,
      eventIds: ['event-p'],
      text: 'done',
      attempt: 1,
    })
  ).resolves.toBeUndefined();
  expect(mocks.settle).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ result: 'delivered' })
  );
});

it('passes the identity observed before receipt lookup when recovering an absent claim', async () => {
  mocks.receipt.mockImplementation(() => {
    mocks.session.mockResolvedValue({
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      providerSessionId: 'changed-during-lookup',
      workspace: { status: 'READY', worktreePath: tmpdir() },
    });
    return Promise.resolve('absent');
  });
  await recoverPRDeliveries('main');
  expect(mocks.recover).toHaveBeenCalledWith('delivery', false, {
    sessionId: 'main',
    provider: 'CLAUDE',
    providerSessionId: 'original',
  });
});

it('pauses an absent frozen claim when its receipt identity cannot be safely recovered', async () => {
  mocks.receipt.mockResolvedValue('absent');
  mocks.recover.mockResolvedValue({ count: 0, status: 'identity_mismatch' });
  await recoverPRDeliveries('main');
  expect(mocks.pause).toHaveBeenCalledWith('w', 'RECEIPT_UNAVAILABLE', 1);
});

it('keeps monitoring active when another recovery settles the delivery first', async () => {
  mocks.receipt.mockResolvedValue('absent');
  mocks.recover.mockResolvedValue({ count: 0, status: 'settled' });
  await recoverPRDeliveries('main');
  expect(mocks.recover).toHaveBeenCalledWith('delivery', false, {
    sessionId: 'main',
    provider: 'CLAUDE',
    providerSessionId: 'original',
  });
  expect(mocks.pause).not.toHaveBeenCalled();
});

it('captures a rollover that completes while pending deliveries are read', async () => {
  mocks.pending.mockImplementation(() => {
    mocks.session.mockResolvedValue({
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      providerSessionId: 'rolled-over',
      workspace: { status: 'READY', worktreePath: tmpdir() },
    });
    return Promise.resolve([
      {
        id: 'event',
        workspaceId: 'w',
        prId: 'p',
        state: 'DISPATCHING',
        deliveryId: 'delivery',
        deliverySessionId: 'main',
        deliveryProvider: 'CLAUDE',
        deliveryProviderSessionId: 'original',
      },
    ]);
  });
  mocks.receipt.mockResolvedValue('absent');
  await recoverPRDeliveries('main');
  expect(mocks.recover).toHaveBeenCalledWith('delivery', false, {
    sessionId: 'main',
    provider: 'CLAUDE',
    providerSessionId: 'rolled-over',
  });
  expect(mocks.pause).not.toHaveBeenCalled();
});

it('captures each delivery identity after the preceding receipt lookup completes', async () => {
  mocks.pending.mockResolvedValue([
    { deliveryId: 'first', deliverySessionId: 'main' },
    { deliveryId: 'second', deliverySessionId: 'main' },
  ]);
  mocks.receipt.mockImplementation(() => {
    mocks.session.mockResolvedValue({
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      providerSessionId: 'rolled-over',
      workspace: { status: 'READY', worktreePath: tmpdir() },
    });
    return Promise.resolve('absent');
  });
  await recoverPRDeliveries('main');
  expect(mocks.recover.mock.calls).toEqual([
    ['first', false, { sessionId: 'main', provider: 'CLAUDE', providerSessionId: 'original' }],
    ['second', false, { sessionId: 'main', provider: 'CLAUDE', providerSessionId: 'rolled-over' }],
  ]);
});

it('ignores legacy enable controls when waking delivery without PR events', async () => {
  mocks.pending.mockResolvedValue([
    { id: 'control', prId: null, kind: 'MONITORING_ENABLED', state: 'PENDING' },
  ]);
  await wakePRDelivery('w');
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('discards previously queued updates without a PR before preparation', async () => {
  expect(
    await preparePRDelivery({
      sessionId: 'main',
      request: { workspaceId: 'w', prId: null, bindingRevision: 1 },
    })
  ).toEqual({ status: 'discard' });
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('queues real PR events even alongside a legacy enable control', async () => {
  mocks.pending.mockResolvedValue([
    { id: 'control', prId: null, kind: 'MONITORING_ENABLED', state: 'PENDING' },
    { id: 'fact', prId: 'p', kind: 'CI_FAILED', state: 'PENDING' },
  ]);
  await wakePRDelivery('w');
  expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith('main', {
    workspaceId: 'w',
    prId: 'p',
    bindingRevision: 1,
  });
});

function queuedFact(prId: string, id = `event-${prId}`) {
  return {
    id,
    workspaceId: 'w',
    prId,
    state: 'PENDING',
    attempts: 0,
    deliveryId: null,
    payload: {
      kind: 'CI_FAILED',
      target: { workspaceId: 'w', prId },
      observation: {
        ...redObservation,
        number: prId === 'p' ? 1 : 2,
        url: `https://github.com/org/repo/pull/${prId === 'p' ? 1 : 2}`,
      },
    },
  };
}
it('refreshes and claims all main PR updates in one delivery without legacy controls', async () => {
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.list).mockResolvedValue([
    { id: 'p' },
    { id: 'q' },
  ] as never);
  const pending = [
    { id: 'control', prId: null, state: 'PENDING' },
    queuedFact('p'),
    queuedFact('q'),
  ];
  mocks.pending.mockImplementation(async (_workspaceId, prId) =>
    prId === undefined ? pending : pending.filter((e) => e.prId === prId)
  );
  mocks.claim.mockImplementation(async (_request, input) => ({
    ...input,
    bindingRevision: 1,
    attempt: 1,
  }));
  const result = await preparePRDelivery({
    sessionId: 'main',
    request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
  });
  expect(result).toMatchObject({ status: 'ready', delivery: { eventIds: ['event-p', 'event-q'] } });
  expect(mocks.observe).toHaveBeenCalledWith(
    expect.anything(),
    { workspaceId: 'w', prId: 'q' },
    { force: true }
  );
  expect(mocks.claim).toHaveBeenCalledWith(
    { workspaceId: 'w', prId: null, bindingRevision: 1 },
    expect.objectContaining({ text: expect.stringContaining('https://github.com/org/repo/pull/2') })
  );
});
it('retries a frozen multi-PR batch with exactly its original events and text', async () => {
  const frozen = ['p', 'q'].map((prId) => ({
    ...queuedFact(prId),
    deliveryId: 'frozen',
    deliveryText: 'exact original text',
    deliverySessionId: 'main',
    deliveryProvider: 'CLAUDE',
    deliveryProviderSessionId: 'original',
  }));
  const pending = [...frozen, queuedFact('q', 'newer')];
  mocks.pending.mockImplementation(async (_workspaceId, prId) =>
    prId === undefined ? pending : pending.filter((e) => e.prId === prId)
  );
  mocks.claim.mockImplementation(async (_request, input) => ({
    ...input,
    bindingRevision: 1,
    attempt: 2,
  }));
  expect(
    await preparePRDelivery({
      sessionId: 'main',
      request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
    })
  ).toMatchObject({
    status: 'ready',
    delivery: {
      deliveryId: 'frozen',
      text: 'exact original text',
      eventIds: ['event-p', 'event-q'],
    },
  });
});
it('rejects a prepared batch when a sibling PR becomes detached before submission', async () => {
  mocks.pending.mockResolvedValue(
    ['p', 'q'].map((prId) => ({
      ...queuedFact(prId),
      state: 'DISPATCHING',
      deliveryId: 'delivery',
    }))
  );
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.find).mockImplementation(
    async ({ prId }) => (prId === 'q' ? null : ({ id: 'p' } as never))
  );
  expect(
    await prBackgroundDeliveryPort.validate({
      deliveryId: 'delivery',
      sessionId: 'main',
      bindingRevision: 1,
      eventIds: ['event-p', 'event-q'],
      text: 'frozen',
      attempt: 1,
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'original',
    })
  ).toBe(false);
});
it('rejects a prepared batch when one claimed event is missing', async () => {
  expect(
    await prBackgroundDeliveryPort.validate({
      deliveryId: 'delivery',
      sessionId: 'main',
      bindingRevision: 1,
      eventIds: ['event', 'missing'],
      text: 'frozen',
      attempt: 1,
      deliveryProvider: 'CLAUDE',
      deliveryProviderSessionId: 'original',
    })
  ).toBe(false);
});
