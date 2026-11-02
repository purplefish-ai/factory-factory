import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EventLaunchClaim } from '@/backend/services/agent-definition';
import { configService } from '@/backend/services/config.service';
import { createEventRunConsumer } from './event-run-consumer.orchestrator';
import { deferred } from './testing/event-delivery.test-support';

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  renew: vi.fn(),
  recover: vi.fn(),
  list: vi.fn(),
  adopt: vi.fn(),
  dispose: vi.fn(),
  launch: vi.fn(),
  observe: vi.fn(),
}));
vi.mock('@/backend/services/agent-definition', () => ({
  agentInitialDelivery: {},
  eventRunLaunch: ports,
}));
vi.mock('@/backend/db', () => ({ prisma: {} }));
vi.mock('@/backend/services/session', async () => {
  const { withEventEvidenceDeadline } = await vi.importActual<
    typeof import('@/backend/services/session')
  >('@/backend/services/session');
  return { eventSessionAuthority: { configure: vi.fn() }, withEventEvidenceDeadline };
});
vi.mock('./event-run-launch.orchestrator', () => ({ launchEventRun: ports.launch }));
vi.mock('./event-run-monitor.orchestrator', () => ({ observeEventRun: ports.observe }));
const claim = (runId: string, workerGeneration = 1): EventLaunchClaim => ({
  status: 'CLAIMED',
  runId,
  workerGeneration,
  attemptGeneration: 1,
  reservedWorkspaceId: `workspace-${runId}`,
  reservedSessionId: `session-${runId}`,
  initialMessageId: `message-${runId}`,
});
const snapshot = (owner: EventLaunchClaim) => ({
  claim: owner,
  leaseExpiresAt: new Date(Date.now() + 60_000),
  phase: 'ACTIVE',
  delivery: { state: 'FINISHED' },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(configService, 'getAgentRuntimeLimits').mockReturnValue({
    ...configService.getAgentRuntimeLimits(),
    activeGlobal: 1,
  });
  ports.read.mockImplementation(async (owner: EventLaunchClaim) => snapshot(owner));
  ports.renew.mockImplementation(async () => new Date(Date.now() + 60_000));
  ports.recover.mockResolvedValue([]);
  ports.list.mockResolvedValue({ runs: [], invalid: [], nextCursor: null });
  ports.launch.mockResolvedValue(undefined);
  ports.observe.mockResolvedValue('HELD');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('rechecks local capacity after committed adoption returns', async () => {
  const consumer = createEventRunConsumer();
  const expired = claim('expired');
  const adopted = claim('expired', 2);
  const pending = deferred<void>();
  ports.list.mockResolvedValueOnce({
    runs: [{ ...snapshot(expired), leaseExpiresAt: new Date(0) }],
    invalid: [],
    nextCursor: null,
  });
  ports.adopt.mockImplementationOnce(async () => {
    await pending.promise;
    return snapshot(adopted);
  });
  const maintenance = consumer.maintain(new AbortController().signal);
  await vi.waitFor(() => expect(ports.adopt).toHaveBeenCalledOnce());
  await consumer.consumeClaim(claim('concurrent'), new AbortController().signal);
  await consumer.drain();
  ports.read.mockClear();
  pending.resolve();
  await maintenance;
  await consumer.drain();
  expect(ports.read).not.toHaveBeenCalledWith(adopted);
  expect(ports.launch).toHaveBeenCalledOnce();
  expect(consumer.canClaim()).toBe(false);
});

it('releases local capacity when a launch succeeds after maintenance revoked it', async () => {
  const consumer = createEventRunConsumer();
  const pending = deferred<void>();
  ports.launch.mockReturnValueOnce(pending.promise);
  await consumer.consumeClaim(claim('late'), new AbortController().signal);
  await vi.waitFor(() => expect(ports.launch).toHaveBeenCalledOnce());
  ports.renew.mockRejectedValueOnce(new Error('Lease lost'));
  await consumer.maintain(new AbortController().signal);
  expect(consumer.canClaim()).toBe(false);
  pending.resolve();
  await consumer.drain();
  expect(consumer.canClaim()).toBe(true);
});

it('does not let a late revoked observer remove a replacement local owner', async () => {
  vi.useFakeTimers();
  const consumer = createEventRunConsumer();
  const first = claim('same');
  await consumer.consumeClaim(first, new AbortController().signal);
  await consumer.drain();
  const pending = deferred<void>();
  ports.observe.mockImplementationOnce(async () => {
    await pending.promise;
    return 'SETTLED';
  });
  const maintenance = consumer.maintain(new AbortController().signal);
  await vi.waitFor(() => expect(ports.observe).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(5001);
  await maintenance;
  expect(consumer.canClaim()).toBe(true);
  const replacement = claim('same', 2);
  await consumer.consumeClaim(replacement, new AbortController().signal);
  await consumer.drain();
  pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(consumer.canClaim()).toBe(false);
  await consumer.maintain(new AbortController().signal);
  expect(ports.renew).toHaveBeenLastCalledWith(replacement, expect.any(Function));
});
