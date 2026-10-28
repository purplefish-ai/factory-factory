import { tmpdir } from 'node:os';
import { beforeEach, expect, it, vi } from 'vitest';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';

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
import { preparePRDelivery } from './pr-event-delivery.orchestrator';

function fact(prId: string, id = `event-${prId}`) {
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
        url: `https://github.com/org/repo/pull/${prId}`,
        headBranch: 'feature',
      },
    },
  };
}
const request = { workspaceId: 'w', prId: 'p', bindingRevision: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({
    enabled: true,
    deliveryMode: 'MAIN',
    workspaceId: 'w',
    recipientSessionId: 'main',
    bindingRevision: 1,
    deliveryPauseReason: null,
  });
  mocks.session.mockResolvedValue({
    id: 'main',
    workspaceId: 'w',
    workflow: 'implement',
    provider: 'CLAUDE',
    providerSessionId: 'original',
    workspace: { status: 'READY', worktreePath: tmpdir() },
  });
  mocks.busy.mockReturnValue(false);
  mocks.interaction.mockReturnValue(null);
  mocks.otherReady.mockResolvedValue(true);
  mocks.observe.mockResolvedValue(true);
  mocks.pending.mockResolvedValue([fact('p'), fact('q')]);
  mocks.claim.mockImplementation(async (_request, input) => ({
    ...input,
    bindingRevision: 1,
    attempt: 1,
  }));
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.find).mockResolvedValue({
    id: 'p',
  } as never);
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.list).mockResolvedValue([
    { id: 'p' },
    { id: 'q' },
    { id: 'unrelated-idle' },
  ] as never);
});
it('refreshes each pending candidate PR once and skips unrelated attached PRs', async () => {
  mocks.pending.mockResolvedValue([fact('p'), fact('p', 'more-p'), fact('q')]);
  expect(await preparePRDelivery({ sessionId: 'main', request })).toMatchObject({
    status: 'ready',
    delivery: { eventIds: ['event-p', 'more-p', 'event-q'] },
  });
  expect(mocks.observe.mock.calls.map(([, target]) => target.prId)).toEqual(['p', 'q']);
});
it('leaves a failed candidate pending while preparing a healthy sibling', async () => {
  mocks.observe.mockImplementation((_ports, { prId }) => {
    if (prId === 'p') {
      throw new Error('Unreachable PR repository');
    }
    return true;
  });
  expect(await preparePRDelivery({ sessionId: 'main', request })).toMatchObject({
    status: 'ready',
    delivery: { eventIds: ['event-q'] },
  });
  expect(mocks.pause).not.toHaveBeenCalled();
});
it('bounds refresh concurrency while allowing independent candidates to start together', async () => {
  const ids = ['p', 'q', 'r', 's', 't'];
  mocks.pending.mockResolvedValue(ids.map((id) => fact(id)));
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.list).mockResolvedValue(
    ids.map((id) => ({ id })) as never
  );
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maximum = 0;
  mocks.observe.mockImplementation(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await blocked;
    active--;
    return true;
  });
  const preparation = preparePRDelivery({ sessionId: 'main', request });
  try {
    await vi.waitFor(() => expect(mocks.observe).toHaveBeenCalledTimes(3), { timeout: 100 });
  } finally {
    release();
    await preparation;
  }
  expect(maximum).toBe(3);
  expect(mocks.observe).toHaveBeenCalledTimes(5);
});
it('reuses frozen text and every original event without new GitHub refreshes', async () => {
  const frozen = ['p', 'q'].map((prId) => ({
    ...fact(prId),
    deliveryId: 'frozen',
    deliveryText: 'unchanged frozen facts',
    deliverySessionId: 'main',
    deliveryProvider: 'CLAUDE',
    deliveryProviderSessionId: 'original',
  }));
  mocks.pending.mockResolvedValue([...frozen, fact('newer')]);
  mocks.observe.mockRejectedValue(new Error('GitHub is offline'));
  expect(await preparePRDelivery({ sessionId: 'main', request })).toMatchObject({
    status: 'ready',
    delivery: {
      deliveryId: 'frozen',
      text: 'unchanged frozen facts',
      eventIds: ['event-p', 'event-q'],
    },
  });
  expect(mocks.observe).not.toHaveBeenCalled();
});
it('splits valid MAIN identity volume and claims exactly represented facts over successive turns', async () => {
  let pending = Array.from({ length: 70 }, (_, index) => {
    const event = fact(`pr-${index}`);
    return {
      ...event,
      payload: {
        ...event.payload,
        observation: {
          ...event.payload.observation,
          headBranch: `feature-${'a'.repeat(300)}-${index}`,
        },
      },
    };
  });
  vi.mocked(defaultPRDeliveryPorts.workspacePrSnapshotService.list).mockResolvedValue(
    pending.map((event) => ({ id: event.prId })) as never
  );
  mocks.pending.mockImplementation(async () => pending);
  const delivered = new Set<string>();
  let batches = 0;
  while (pending.length && batches < 10) {
    const result = await preparePRDelivery({ sessionId: 'main', request });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      throw new Error('Expected bounded delivery');
    }
    expect(result.delivery.eventIds.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.delivery.text)).toBeLessThanOrEqual(16_384);
    for (const event of pending) {
      if (result.delivery.eventIds.includes(event.id)) {
        expect(result.delivery.text).toContain(JSON.stringify(event.payload.observation.url));
        expect(delivered.has(event.id)).toBe(false);
        delivered.add(event.id);
      } else {
        expect(result.delivery.text).not.toContain(JSON.stringify(event.payload.observation.url));
      }
    }
    pending = pending.filter((event) => !result.delivery.eventIds.includes(event.id));
    batches++;
  }
  expect(delivered.size).toBe(70);
  expect(batches).toBeGreaterThan(1);
  expect(mocks.pause).not.toHaveBeenCalled();
});
it('discards an obsolete placeholder when refresh supersedes every pending fact', async () => {
  let pending = [fact('p')];
  mocks.pending.mockImplementation(() => Promise.resolve(pending));
  mocks.observe.mockImplementation(() => {
    pending = [];
    return Promise.resolve(true);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request })).toEqual({ status: 'discard' });
  expect(mocks.claim).not.toHaveBeenCalled();
});
