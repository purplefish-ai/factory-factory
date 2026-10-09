import { beforeEach, expect, it, vi } from 'vitest';
import { ensureDedicatedPRRecipient } from '@/backend/orchestration/pr-dedicated-session.orchestrator';
import type { PRDedicatedSessionPorts } from '@/backend/orchestration/pr-monitoring-ports';
import type { AgentSessionRecord } from '@/backend/services/session';

const target = { workspaceId: 'w', prId: 'a', bindingRevision: 4 };
function harness() {
  const session: AgentSessionRecord = {
    id: 'dedicated',
    workspaceId: 'w',
    workspacePrId: 'a',
    workflow: 'pr-monitoring',
    provider: 'CLAUDE',
    model: 'sonnet',
    status: 'IDLE',
    name: null,
    providerProjectPath: null,
    providerProcessPid: null,
    providerMetadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
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
  const getClient = vi.fn().mockReturnValue(undefined);
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
    acpRuntimeManager: { isSessionWorking: working, getClient },
  } as unknown as PRDedicatedSessionPorts;
  return {
    session,
    services,
    acquire,
    start,
    pause,
    pending,
    working,
    getClient,
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

it('lets a current wake complete bootstrap when an earlier coalesced wake is cancelled', async () => {
  const h = harness();
  let firstCurrent = true;
  let release!: () => void;
  h.start.mockImplementation(
    (_id, options) =>
      new Promise<void>((resolve, reject) => {
        release = () => {
          void options.assertCurrent().then(() => {
            h.session.providerSessionId = 'original';
            resolve();
          }, reject);
        };
      })
  );
  const first = ensureDedicatedPRRecipient(target, h.services, () => firstCurrent);
  await vi.waitFor(() => expect(h.start).toHaveBeenCalled());
  const second = ensureDedicatedPRRecipient(target, h.services, () => true);
  firstCurrent = false;
  release();
  expect(await first).toBeNull();
  expect(await second).toMatchObject({ providerSessionId: 'original' });
  expect(h.start).toHaveBeenCalledTimes(1);
});

it('recovers the exact healthy dedicated conversation created by a concurrent startup', async () => {
  const h = harness();
  h.start.mockImplementation(() => {
    h.session.providerSessionId = 'concurrent-provider';
    h.getClient.mockReturnValue({
      provider: 'CLAUDE',
      providerSessionId: 'concurrent-provider',
      sessionCreationOutcome: { kind: 'new' },
      isRunning: () => true,
    });
    return Promise.reject(new Error('Session is already running'));
  });
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toMatchObject({
    id: 'dedicated',
    provider: 'CLAUDE',
    providerSessionId: 'concurrent-provider',
  });
  expect(h.pause).not.toHaveBeenCalled();
});
it.each([
  'binding',
  'workspace',
  'pr',
  'workflow',
  'provider',
  'identity',
  'fallback',
  'stopped',
  'cold',
] as const)('does not recover a concurrent startup with invalid %s evidence', async (invalid) => {
  const h = harness();
  h.start.mockImplementation(() => {
    h.session.providerSessionId = 'concurrent-provider';
    const bindingOverrides: Record<string, Partial<AgentSessionRecord>> = {
      binding: { id: 'replacement' },
      workspace: { workspaceId: 'other' },
      pr: { workspacePrId: 'other-pr' },
      workflow: { workflow: 'implement' },
      provider: { provider: 'CODEX' },
    };
    const bound = { ...h.session, ...bindingOverrides[invalid] };
    vi.mocked(h.services.sessionDataService.findPRDedicatedSession).mockResolvedValue(bound);
    h.getClient.mockReturnValue(
      invalid === 'cold'
        ? undefined
        : {
            provider: bound.provider,
            providerSessionId:
              invalid === 'identity' ? 'replacement-provider' : bound.providerSessionId,
            sessionCreationOutcome: { kind: invalid === 'fallback' ? 'resume_fallback' : 'new' },
            isRunning: () => invalid !== 'stopped',
          }
    );
    return Promise.reject(new Error('Session is already running'));
  });
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toBeNull();
  expect(h.pause).toHaveBeenCalledExactlyOnceWith('w', 'RESUME_FAILED', 4);
});
it('fences concurrent-start recovery when destination changes while the binding is read', async () => {
  const h = harness();
  h.start.mockImplementation(() => {
    vi.mocked(h.services.sessionDataService.findPRDedicatedSession).mockImplementation(() => {
      h.change();
      return Promise.resolve({ ...h.session, providerSessionId: 'concurrent-provider' });
    });
    h.getClient.mockReturnValue({
      provider: 'CLAUDE',
      providerSessionId: 'concurrent-provider',
      sessionCreationOutcome: { kind: 'new' },
      isRunning: () => true,
    });
    return Promise.reject(new Error('Session is already running'));
  });
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toBeNull();
  expect(h.pause).not.toHaveBeenCalled();
});

it('returns a saved dedicated recipient while its workspace is busy so its card can be queued', async () => {
  const h = harness();
  h.session.providerSessionId = 'saved-provider';
  h.working.mockReturnValue(true);
  expect(await ensureDedicatedPRRecipient(target, h.services, () => true)).toMatchObject({
    id: 'dedicated',
    providerSessionId: 'saved-provider',
  });
  expect(h.acquire).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});
