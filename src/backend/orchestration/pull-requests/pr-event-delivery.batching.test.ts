import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  undeliverable: vi.fn(),
}));
vi.mock('./pr-delivery-readiness', () => ({ recipientCanDispatch: mocks.otherReady }));
vi.mock('./pr-observation.orchestrator', () => ({
  observeMonitoredPR: mocks.observe,
}));

vi.mock('./pr-dedicated-session.orchestrator', () => ({
  ensureDedicatedPRRecipient: mocks.ensureDedicated,
}));
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createPRDeliveryPorts } from './pr-delivery-dependencies';
import { createPRBackgroundDeliveryPort } from './pr-event-delivery-port';
import { preparePRDelivery, wakePRDelivery } from './pr-event-delivery.orchestrator';
import type { PRMonitoringServices } from './pr-monitoring-dependencies';

// One explicit application graph; delivery receives every capability as a port.
const ports = createPRDeliveryPorts(
  unsafeCoerce<PRMonitoringServices>({
    prObservationService: {},
    prSnapshotService: {},
    ratchetService: { emit: mocks.emit },
    acpRuntimeManager: {
      isSessionPromptInFlight: mocks.busy,
      isSessionWorking: () => true,
    },
    sessionDispatchService: { tryDispatchNextMessage: mocks.dispatch },
    findPRDeliveryReceipt: mocks.receipt,
    sessionBackgroundDeliveryService: {
      invalidate: mocks.invalidate,
      enqueue: mocks.enqueue,
      isDeliveryActive: mocks.active,
    },
    sessionDataService: {
      findAgentSessionById: mocks.session,
      findPRDedicatedSession: mocks.dedicated,
    },
    sessionDomainService: { getPendingInteractiveRequest: mocks.interaction },
    sessionLifecycleService: {},
    userSettingsService: { get: vi.fn(async () => ({ ratchetReplyToPrComments: true })) },
    workspacePRMonitoringService: {
      get: mocks.get,
      listPending: mocks.pending,
      claimDelivery: mocks.claim,
      recoverClaim: mocks.recover,
      pauseWorkspace: mocks.pause,
      pause: mocks.pause,
      resume: mocks.resume,
      cancelRecoveredDelivery: mocks.cancel,
      cancelUndeliverable: mocks.undeliverable,
      settleDelivery: mocks.settle,
    },
    workspacePrSnapshotService: { find: vi.fn(), list: vi.fn() },
  })
);

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
  mocks.enqueue.mockReturnValue({ queued: true });
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.pending.mockResolvedValue([fact('p'), fact('q')]);
  mocks.claim.mockImplementation(async (_request, input) => ({
    ...input,
    bindingRevision: 1,
    attempt: 1,
  }));
  vi.mocked(ports.workspacePrSnapshotService.find).mockResolvedValue({
    id: 'p',
  } as never);
  vi.mocked(ports.workspacePrSnapshotService.list).mockResolvedValue([
    { id: 'p' },
    { id: 'q' },
    { id: 'unrelated-idle' },
  ] as never);
});
it('dispatches the resolved PR batch through the injected background capabilities', async () => {
  const operations: string[] = [];
  const backgroundDispatch = {
    enqueue: (sessionId: string, request: { prId: string | null }) => {
      operations.push(`enqueue:${sessionId}:${request.prId}`);
      return { queued: true };
    },
    wakeSession: (sessionId: string) => {
      operations.push(`wake:${sessionId}`);
      return Promise.resolve();
    },
    logger: { warn: vi.fn() },
  };
  await wakePRDelivery('w', { ...ports, backgroundDispatch });
  expect(operations).toEqual(['enqueue:main:p', 'enqueue:main:q', 'wake:main']);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('refreshes each pending candidate PR once and skips unrelated attached PRs', async () => {
  mocks.pending.mockResolvedValue([fact('p'), fact('p', 'more-p'), fact('q')]);
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toMatchObject({
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
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toMatchObject({
    status: 'ready',
    delivery: { eventIds: ['event-q'] },
  });
  expect(mocks.pause).not.toHaveBeenCalled();
});
it('bounds refresh concurrency while allowing independent candidates to start together', async () => {
  const ids = ['p', 'q', 'r', 's', 't'];
  mocks.pending.mockResolvedValue(ids.map((id) => fact(id)));
  vi.mocked(ports.workspacePrSnapshotService.list).mockResolvedValue(
    ids.map((id) => ({ id })) as never
  );
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let maximum = 0;
  let thirdStarted!: () => void;
  const threeRunning = new Promise<void>((resolve) => {
    thirdStarted = resolve;
  });
  mocks.observe.mockImplementation(async () => {
    active++;
    maximum = Math.max(maximum, active);
    if (active === 3) {
      thirdStarted();
    }
    await blocked;
    active--;
    return true;
  });
  const preparation = preparePRDelivery({ sessionId: 'main', request }, ports);
  try {
    // Wait for the refreshes themselves, not a deadline: preparation stats the
    // real worktree first, and that file system call has no fixed duration.
    await threeRunning;
    expect(mocks.observe).toHaveBeenCalledTimes(3);
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
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toMatchObject({
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
  vi.mocked(ports.workspacePrSnapshotService.list).mockResolvedValue(
    pending.map((event) => ({ id: event.prId })) as never
  );
  mocks.pending.mockImplementation(async () => pending);
  const delivered = new Set<string>();
  let batches = 0;
  while (pending.length && batches < 10) {
    const result = await preparePRDelivery({ sessionId: 'main', request }, ports);
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
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toEqual({
    status: 'discard',
  });
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('discards a stored fact it cannot read and delivers the rest without pausing', async () => {
  const unreadable = { ...fact('p', 'unreadable'), payload: { kind: 'FROM_ANOTHER_BUILD' } };
  mocks.pending.mockResolvedValue([unreadable, fact('p'), fact('q')]);
  const prepared = await preparePRDelivery({ sessionId: 'main', request }, ports);
  expect(mocks.undeliverable).toHaveBeenCalledExactlyOnceWith('w', ['unreadable']);
  expect(mocks.pause).not.toHaveBeenCalled();
  expect(prepared).toMatchObject({
    status: 'ready',
    delivery: { eventIds: ['event-p', 'event-q'] },
  });
});

it('bounds the reads one three-PR MAIN delivery makes from preparation to final validation', async () => {
  mocks.pending.mockResolvedValue([fact('p'), fact('q'), fact('r')]);
  const prepared = await preparePRDelivery({ sessionId: 'main', request }, ports);
  expect(prepared).toMatchObject({
    status: 'ready',
    delivery: { eventIds: ['event-p', 'event-q', 'event-r'] },
  });
  if (prepared.status !== 'ready') {
    throw new Error('Expected a claimed delivery');
  }
  const claimed = {
    ...prepared.delivery,
    deliveryProvider: 'CLAUDE' as const,
    deliveryProviderSessionId: 'original',
  };
  mocks.pending.mockResolvedValue(
    ['p', 'q', 'r'].map((prId) => ({
      ...fact(prId),
      state: 'DISPATCHING',
      deliveryId: claimed.deliveryId,
    }))
  );
  expect(await createPRBackgroundDeliveryPort(ports).validate(claimed)).toBe(true);
  const reads = {
    monitoringConfig: mocks.get.mock.calls.length,
    pendingEvents: mocks.pending.mock.calls.length,
    session: mocks.session.mock.calls.length,
    workspaceSessions: mocks.otherReady.mock.calls.length,
    dedicatedBinding: mocks.dedicated.mock.calls.length,
    prRows: vi.mocked(ports.workspacePrSnapshotService.find).mock.calls.length,
    settings: vi.mocked(ports.userSettingsService.get).mock.calls.length,
    worktree: vi.mocked(filesystem.stat).mock.calls.length,
  };
  // Three guard evaluations: before the refresh, before the claim (all three PRs
  // at once) and in validate (all three PRs at once). Each reads the binding,
  // the recipient and the workspace's sessions before and after the worktree
  // check. Before this bound, one full guard per PR made 81 reads.
  expect(reads).toEqual({
    monitoringConfig: 7,
    pendingEvents: 3,
    session: 7,
    workspaceSessions: 6,
    dedicatedBinding: 0,
    prRows: 10,
    settings: 1,
    worktree: 3,
  });
  expect(Object.values(reads).reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(37);
  expect(mocks.observe).toHaveBeenCalledTimes(3);
  expect(mocks.claim).toHaveBeenCalledOnce();
});

it('discards the queued placeholder when no stored fact can be read', async () => {
  mocks.pending.mockResolvedValue([
    { ...fact('p', 'unreadable'), payload: { kind: 'FROM_ANOTHER_BUILD' } },
  ]);
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toEqual({
    status: 'discard',
  });
  expect(mocks.undeliverable).toHaveBeenCalledExactlyOnceWith('w', ['unreadable']);
  expect(mocks.pause).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});

function monitoring(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    deliveryMode: 'MAIN',
    workspaceId: 'w',
    recipientSessionId: 'main',
    bindingRevision: 1,
    deliveryPauseReason: null,
    ...overrides,
  };
}

// The guard before the refresh keeps GitHub untouched for a delivery that cannot go.
it('does not refresh GitHub for a request whose binding is already stale', async () => {
  mocks.get.mockResolvedValue(monitoring({ bindingRevision: 2 }));
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toEqual({
    status: 'discard',
  });
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});

// The guard before the claim closes every race that can happen during the refresh.
it.each([
  ['the recipient starts a prompt', () => mocks.busy.mockReturnValue(true)],
  [
    'the recipient opens an interaction',
    () => mocks.interaction.mockReturnValue({ requestId: 'approval' }),
  ],
  ['another session starts a prompt', () => mocks.otherReady.mockResolvedValue(false)],
  [
    'the user pauses delivery',
    () => mocks.get.mockResolvedValue(monitoring({ deliveryPauseReason: 'USER_STOPPED' })),
  ],
])('keeps the update queued without claiming when %s during the refresh', async (_, change) => {
  mocks.observe.mockImplementation(() => {
    change();
    return Promise.resolve(true);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toMatchObject({
    status: 'blocked',
    reason: 'Recipient is paused or busy',
  });
  expect(mocks.claim).not.toHaveBeenCalled();
});

it.each([
  ['the binding changes', () => mocks.get.mockResolvedValue(monitoring({ bindingRevision: 2 }))],
  [
    'the main recipient switches',
    () => mocks.get.mockResolvedValue(monitoring({ recipientSessionId: 'other' })),
  ],
  [
    'the recipient workspace stops being ready',
    () =>
      mocks.session.mockResolvedValue({
        id: 'main',
        workspaceId: 'w',
        workflow: 'implement',
        provider: 'CLAUDE',
        providerSessionId: 'original',
        workspace: { status: 'ARCHIVING', worktreePath: tmpdir() },
      }),
  ],
])('discards the update without claiming when %s during the refresh', async (_, change) => {
  mocks.observe.mockImplementation(() => {
    change();
    return Promise.resolve(true);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toEqual({
    status: 'discard',
  });
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('discards the update without claiming when a batch sibling is detached during the refresh', async () => {
  const find = vi.mocked(ports.workspacePrSnapshotService.find);
  mocks.observe.mockImplementation((_ports, { prId }) => {
    if (prId === 'q') {
      find.mockImplementation((target) =>
        Promise.resolve(target.prId === 'q' ? null : ({ id: 'p' } as never))
      );
    }
    return Promise.resolve(true);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toEqual({
    status: 'discard',
  });
  expect(find).toHaveBeenLastCalledWith({ workspaceId: 'w', prId: 'q' });
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('pauses as SESSION_FAILED without claiming when the worktree disappears during the refresh', async () => {
  mocks.pause.mockResolvedValue({ count: 1 });
  mocks.observe.mockImplementation(() => {
    mocks.session.mockResolvedValue({
      id: 'main',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      providerSessionId: 'original',
      workspace: { status: 'READY', worktreePath: null },
    });
    return Promise.resolve(true);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toMatchObject({
    status: 'blocked',
  });
  expect(mocks.pause).toHaveBeenCalledExactlyOnceWith('w', 'SESSION_FAILED', 1);
  expect(mocks.invalidate).toHaveBeenCalledWith('w', 1);
  expect(mocks.emit).toHaveBeenCalledWith('ratchet_dispatch_changed', { workspaceId: 'w' });
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('rechecks the recipient after the worktree check that precedes the claim', async () => {
  const { stat: realStat } =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let checks = 0;
  vi.mocked(filesystem.stat).mockImplementation((path) => {
    // The second worktree check is the one immediately before the claim.
    if (++checks === 2) {
      mocks.busy.mockReturnValue(true);
    }
    return realStat(path);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toMatchObject({
    status: 'blocked',
  });
  expect(checks).toBe(2);
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('classifies a lost claim with the guard, discarding it once the binding changed', async () => {
  mocks.claim.mockImplementation(() => {
    mocks.get.mockResolvedValue(monitoring({ bindingRevision: 2 }));
    return Promise.resolve(null);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toEqual({
    status: 'discard',
  });
  expect(mocks.claim).toHaveBeenCalledOnce();
});

// The guard after the refresh still precedes every early return and every write.
it('does not cancel unreadable facts after the binding changes during the refresh', async () => {
  const unreadable = { ...fact('p', 'unreadable'), payload: { kind: 'FROM_ANOTHER_BUILD' } };
  mocks.pending.mockResolvedValue([unreadable, fact('p'), fact('q')]);
  mocks.observe.mockImplementation(() => {
    mocks.get.mockResolvedValue(monitoring({ bindingRevision: 2 }));
    return Promise.resolve(true);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toEqual({
    status: 'discard',
  });
  expect(mocks.undeliverable).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('does not pause an exhausted delivery while its recipient became busy during the refresh', async () => {
  mocks.pending.mockResolvedValue([{ ...fact('p'), attempts: 3 }]);
  mocks.observe.mockImplementation(() => {
    mocks.busy.mockReturnValue(true);
    return Promise.resolve(true);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toMatchObject({
    status: 'blocked',
    reason: 'Recipient is paused or busy',
  });
  expect(mocks.pause).not.toHaveBeenCalled();
  mocks.busy.mockReturnValue(false);
  mocks.observe.mockResolvedValue(true);
  mocks.pause.mockResolvedValue({ count: 1 });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toMatchObject({
    status: 'blocked',
    reason: 'PR update transport failed three times',
  });
  expect(mocks.pause).toHaveBeenCalledExactlyOnceWith('w', 'DELIVERY_FAILED', 1);
  expect(mocks.claim).not.toHaveBeenCalled();
});

it('does not pause a frozen retry for an unknown conversation after its binding changed', async () => {
  const frozen = {
    ...fact('p'),
    deliveryId: 'frozen',
    deliveryText: 'frozen text',
    deliverySessionId: 'main',
    deliveryProvider: 'CLAUDE',
    deliveryProviderSessionId: 'previous-conversation',
  };
  mocks.pending.mockImplementation(() => {
    mocks.get.mockResolvedValue(monitoring({ bindingRevision: 2 }));
    return Promise.resolve([frozen]);
  });
  expect(await preparePRDelivery({ sessionId: 'main', request }, ports)).toEqual({
    status: 'discard',
  });
  expect(mocks.pause).not.toHaveBeenCalled();
  expect(mocks.claim).not.toHaveBeenCalled();
});
