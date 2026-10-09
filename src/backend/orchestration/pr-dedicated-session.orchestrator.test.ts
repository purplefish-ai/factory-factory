import { beforeEach, expect, it, vi } from 'vitest';
import { ensureDedicatedPRRecipient } from '@/backend/orchestration/pr-dedicated-session.orchestrator';
import type { PRMonitoringServices } from '@/backend/orchestration/pr-monitoring-dependencies';

const target = { workspaceId: 'w', prId: 'a', bindingRevision: 4 };
function harness() {
  const session = {
    id: 'dedicated',
    workspaceId: 'w',
    workspacePrId: 'a',
    workflow: 'pr-monitoring',
    provider: 'CLAUDE',
    model: 'sonnet',
    providerSessionId: null as string | null,
  };
  let config = {
    enabled: true,
    deliveryMode: 'DEDICATED',
    bindingRevision: 4,
    deliveryPauseReason: null as string | null,
  };
  const acquire = vi
    .fn()
    .mockImplementation(() => Promise.resolve({ outcome: 'created', session: { ...session } }));
  const start = vi.fn().mockImplementation(() => {
    session.providerSessionId = 'original';
    return Promise.resolve();
  });
  const pause = vi.fn().mockImplementation(() => {
    config = { ...config, deliveryPauseReason: 'RESUME_FAILED' };
    return Promise.resolve({ count: 1 });
  });
  const pending = vi.fn().mockResolvedValue([{ prId: 'a', state: 'PENDING' }]);
  const working = vi.fn().mockReturnValue(false);
  const services = {
    sessionBackgroundDeliveryService: { captureResumeGuard: () => () => true },
    configService: { getMaxSessionsPerWorkspace: () => 5 },
    workspacePRMonitoringService: {
      get: vi.fn().mockImplementation(() => Promise.resolve(config)),
      listPending: pending,
      pauseWorkspace: pause,
    },
    sessionDataService: {
      acquirePRDedicatedSession: acquire,
      findAgentSessionsByWorkspaceId: vi.fn().mockResolvedValue([{ id: 'human' }]),
      findPRDedicatedSession: vi.fn().mockImplementation(() => Promise.resolve({ ...session })),
    },
    sessionLifecycleService: { startSession: start },
    acpRuntimeManager: { isSessionWorking: working },
  } as unknown as PRMonitoringServices;
  return {
    session,
    services,
    acquire,
    start,
    pause,
    pending,
    working,
    change: () => {
      config = { ...config, bindingRevision: 5 };
    },
  };
}
beforeEach(() => vi.clearAllMocks());
it('lazily bootstraps provider identity with no separate maintenance prompt', async () => {
  const h = harness();
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toMatchObject({
    id: 'dedicated',
    providerSessionId: 'original',
  });
  expect(h.start).toHaveBeenCalledExactlyOnceWith('dedicated', {
    initialPrompt: '',
    assertCurrent: expect.any(Function),
  });
  expect(h.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: 'w',
      prId: 'a',
      expectedBindingRevision: 4,
      maxSessions: 5,
      isCurrent: expect.any(Function),
    })
  );
});
it('returns the exact cold saved identity without proactive startup or replacement', async () => {
  const h = harness();
  h.session.providerSessionId = 'saved';
  h.acquire.mockResolvedValue({ outcome: 'reused', session: { ...h.session } });
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toMatchObject({
    providerSessionId: 'saved',
  });
  expect(h.start).not.toHaveBeenCalled();
});
it.each(['empty', 'sibling', 'busy'] as const)('does not acquire for %s work', async (reason) => {
  const h = harness();
  if (reason === 'empty') {
    h.pending.mockResolvedValue([]);
  }
  if (reason === 'sibling') {
    h.pending.mockResolvedValue([{ prId: 'b', state: 'PENDING' }]);
  }
  if (reason === 'busy') {
    h.working.mockReturnValue(true);
  }
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toBeNull();
  expect(h.acquire).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});
it.each(['revision', 'stop'] as const)(
  'fences bootstrap when %s changes during acquisition',
  async (reason) => {
    const h = harness();
    let current = true;
    h.acquire.mockImplementation(() => {
      if (reason === 'revision') {
        h.change();
      } else {
        current = false;
      }
      return Promise.resolve({ outcome: 'created', session: { ...h.session } });
    });
    expect(await ensureDedicatedPRRecipient(target, h.services, () => current)).toBeNull();
    expect(h.start).not.toHaveBeenCalled();
  }
);
it('rechecks workspace busy state immediately before bootstrap', async () => {
  const h = harness();
  h.acquire.mockImplementation(() => {
    h.working.mockReturnValue(true);
    return Promise.resolve({ outcome: 'created', session: { ...h.session } });
  });
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toBeNull();
  expect(h.start).not.toHaveBeenCalled();
});
it('coalesces concurrent bootstrap and retains the same binding after startup failure', async () => {
  const h = harness();
  let reject!: (error: Error) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  h.start.mockImplementation(() => {
    entered();
    return new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
  });
  const first = ensureDedicatedPRRecipient(target, h.services, () => true);
  const second = ensureDedicatedPRRecipient(target, h.services, () => true);
  await started;
  reject(new Error('Provider unavailable'));
  expect(await first).toBeNull();
  expect(await second).toBeNull();
  expect(h.start).toHaveBeenCalledTimes(1);
  expect(h.acquire).toHaveBeenCalledTimes(1);
  expect(h.pause).toHaveBeenCalledWith('w', 'RESUME_FAILED', 4);
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toBeNull();
  expect(h.acquire).toHaveBeenCalledTimes(1);
});
it('discards a completed bootstrap after a binding change', async () => {
  const h = harness();
  h.start.mockImplementation(() => {
    h.change();
    h.session.providerSessionId = 'original';
    return Promise.resolve();
  });
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toBeNull();
  expect(h.pause).not.toHaveBeenCalled();
});
