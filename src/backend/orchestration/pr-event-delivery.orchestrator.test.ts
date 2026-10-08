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
}));
vi.mock('@/backend/services/workspace', () => ({
  workspacePRMonitoringService: {
    get: mocks.get,
    listPending: mocks.pending,
    claimDelivery: mocks.claim,
    recoverClaim: mocks.recover,
    pauseWorkspace: mocks.pause,
    cancelRecoveredDelivery: mocks.cancel,
  },
  workspacePrSnapshotService: { find: vi.fn(async () => ({ id: 'p' })) },
}));
vi.mock('@/backend/services/session', () => ({
  acpRuntimeManager: { isSessionWorking: mocks.busy },
  sessionDataService: { findAgentSessionById: mocks.session },
  sessionDomainService: { getPendingInteractiveRequest: mocks.interaction },
  chatMessageHandlerService: {},
  sessionBackgroundDeliveryService: {},
  findPRDeliveryReceipt: mocks.receipt,
}));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({ ratchetReplyToPrComments: true })) },
}));
vi.mock('./pr-observation.orchestrator', () => ({
  observeMonitoredPR: mocks.observe,
  recipientCanDispatch: mocks.otherReady,
}));

import {
  prBackgroundDeliveryPort,
  preparePRDelivery,
  recoverPRDeliveries,
} from './pr-event-delivery.orchestrator';

const config = {
  enabled: true,
  workspaceId: 'w',
  recipientSessionId: 'main',
  bindingRevision: 1,
  deliveryPauseReason: null as string | null,
};
beforeEach(() => {
  config.bindingRevision = 1;
  config.deliveryPauseReason = null;
  mocks.get.mockImplementation(async () => ({ ...config }));
  mocks.session.mockResolvedValue({
    id: 'main',
    workspaceId: 'w',
    workflow: 'implement',
    workspace: { status: 'READY' },
  });
  mocks.busy.mockReturnValue(false);
  mocks.interaction.mockReturnValue(null);
  mocks.otherReady.mockResolvedValue(true);
  mocks.pending.mockResolvedValue([
    {
      id: 'event',
      workspaceId: 'w',
      prId: 'p',
      state: 'DISPATCHING',
      deliveryId: 'delivery',
      deliverySessionId: 'main',
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
