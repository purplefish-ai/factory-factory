import { beforeEach, expect, it, vi } from 'vitest';

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
  workspacePrSnapshotService: { find: vi.fn(async () => ({ id: 'p' })) },
}));
vi.mock('@/backend/services/ratchet', () => ({
  ratchetService: { emit: mocks.emit },
  RATCHET_DISPATCH_CHANGED: 'ratchet_dispatch_changed',
}));
vi.mock('@/backend/services/session', () => ({
  acpRuntimeManager: { isSessionWorking: mocks.busy },
  sessionDataService: { findAgentSessionById: mocks.session },
  sessionDomainService: { getPendingInteractiveRequest: mocks.interaction },
  chatMessageHandlerService: { tryDispatchNextMessage: mocks.dispatch },
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
vi.mock('./pr-observation.orchestrator', () => ({
  observeMonitoredPR: mocks.observe,
  recipientCanDispatch: mocks.otherReady,
}));

import { recoverPRDeliveries } from './pr-delivery-recovery';
import { prBackgroundDeliveryPort } from './pr-event-delivery-port';
import { preparePRDelivery } from './pr-event-delivery.orchestrator';

const config = {
  enabled: true,
  workspaceId: 'w',
  recipientSessionId: 'main',
  bindingRevision: 1,
  deliveryPauseReason: null as string | null,
};
beforeEach(() => {
  vi.resetAllMocks();
  config.recipientSessionId = 'main';
  config.bindingRevision = 1;
  config.deliveryPauseReason = null;
  mocks.get.mockImplementation(async () => ({ ...config }));
  mocks.session.mockResolvedValue({
    id: 'main',
    workspaceId: 'w',
    workflow: 'implement',
    provider: 'CLAUDE',
    providerSessionId: 'original',
    workspace: { status: 'READY' },
  });
  mocks.busy.mockReturnValue(false);
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.interaction.mockReturnValue(null);
  mocks.otherReady.mockResolvedValue(true);
  mocks.pause.mockResolvedValue({ count: 1 });
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
});
it('cancels an old frozen delivery only after provider history proves absence', async () => {
  config.recipientSessionId = 'new-main';
  mocks.receipt.mockResolvedValue('absent');
  await recoverPRDeliveries('main');
  expect(mocks.cancel).toHaveBeenCalledWith('delivery', 'main');
  config.recipientSessionId = 'main';
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
  await preparePRDelivery({
    sessionId: 'main',
    request: { workspaceId: 'w', prId: 'p', bindingRevision: 1 },
  });
  expect(mocks.observe).toHaveBeenCalledWith(
    { workspaceId: 'w', prId: 'p' },
    undefined,
    { force: true },
    expect.anything()
  );
});
it('does not invalidate the bound recipient when an unrelated session stops', async () => {
  config.recipientSessionId = 'different-main';
  await prBackgroundDeliveryPort.pause('main', 'USER_STOPPED');
  expect(mocks.invalidate).not.toHaveBeenCalled();
  config.recipientSessionId = 'main';
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
    await prBackgroundDeliveryPort.fail(
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
