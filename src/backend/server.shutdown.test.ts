import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '@/backend/app-context';
import { deferred } from '@/test-utils/deferred';

vi.mock('@/backend/routers/websocket', () => ({
  createChatUpgradeHandler: vi.fn(() => vi.fn()),
  createTerminalUpgradeHandler: vi.fn(() => vi.fn()),
  createSetupTerminalUpgradeHandler: vi.fn(() => vi.fn()),
  createDevLogsUpgradeHandler: vi.fn(() => vi.fn()),
  createPostRunLogsUpgradeHandler: vi.fn(() => vi.fn()),
  createSnapshotsUpgradeHandler: vi.fn(() => vi.fn()),
  createVoiceUpgradeHandler: vi.fn(() => vi.fn()),
  disposeChatTransportForApplication: vi.fn(),
  disposeSnapshotsHandlerState: vi.fn(),
}));

vi.mock('@/backend/trpc/index', () => ({
  appRouter: {},
  createContext: vi.fn(() => () => ({})),
}));

vi.mock('@trpc/server/adapters/express', () => ({
  createExpressMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createServer } from './server';
import { createTestHarness } from './server.test-helpers';

type Harness = ReturnType<typeof createTestHarness>;

const jobStops = ({ services, lifecycle }: Harness) => ({
  reconciliation: vi.mocked(services.reconciliationService.stopPeriodicCleanup),
  prSync: vi.mocked(services.schedulerService.stop),
  snapshotReconciliation: vi.mocked(lifecycle.snapshotReconciliation.stop),
  ratchet: vi.mocked(services.ratchetService.stop),
  periodicTasks: vi.mocked(services.periodicTaskService.stop),
});

describe('server background job shutdown', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  const createTestServer = (application: Application) => {
    const server = createServer(application, 0);
    servers.push(server);
    return server;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const server of servers) {
      await server.stop();
    }
    servers.length = 0;
  });

  it('signals every job before any drain completes or teardown begins', async () => {
    const harness = createTestHarness();
    const stops = jobStops(harness);
    const drains = Object.values(stops).map((stop) => {
      const drain = deferred<undefined>();
      stop.mockReturnValueOnce(drain.promise);
      return drain;
    });
    const server = createTestServer(harness.application);

    const stopping = server.stop();

    for (const stop of Object.values(stops)) {
      expect(stop).toHaveBeenCalledOnce();
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
        harness.services.agentRuntime.stop.mock.invocationCallOrder[0] ?? 0
      );
    }
    await vi.waitFor(() => expect(harness.services.rateLimiter.stop).toHaveBeenCalledOnce());
    expect(harness.lifecycle.database.$disconnect).not.toHaveBeenCalled();

    for (const drain of drains) {
      drain.resolve(undefined);
    }
    await stopping;
    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('waits for the slowest drain rather than the sum of them', async () => {
    const harness = createTestHarness();
    const durations = {
      reconciliation: 1000,
      prSync: 2000,
      snapshotReconciliation: 4200,
      ratchet: 3000,
      periodicTasks: 1500,
    };
    for (const [job, stop] of Object.entries(jobStops(harness))) {
      const ms = durations[job as keyof typeof durations];
      stop.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, ms)));
    }
    const server = createTestServer(harness.application);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const stopping = server.stop();

    await vi.advanceTimersByTimeAsync(4199);
    expect(harness.lifecycle.database.$disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('logs a failing stop without blocking the other jobs or the disconnect', async () => {
    const harness = createTestHarness();
    const failure = new Error('pr sync stop failed');
    vi.mocked(harness.services.schedulerService.stop).mockRejectedValueOnce(failure);
    vi.mocked(harness.services.ratchetService.stop).mockImplementationOnce(() => {
      throw new Error('ratchet stop threw');
    });
    const server = createTestServer(harness.application);

    await server.stop();

    for (const stop of Object.values(jobStops(harness))) {
      expect(stop).toHaveBeenCalledOnce();
    }
    expect(harness.logger.error).toHaveBeenCalledWith('Failed to stop background job', failure, {
      job: 'pr-sync',
    });
    expect(harness.logger.error).toHaveBeenCalledWith(
      'Failed to stop background job',
      expect.objectContaining({ message: 'ratchet stop threw' }),
      { job: 'ratchet' }
    );
    expect(harness.lifecycle.eventCollector.stop).toHaveBeenCalledOnce();
    expect(harness.services.workspaceGitStateService.stop).toHaveBeenCalledOnce();
    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('disconnects the database only after every drain has settled', async () => {
    const harness = createTestHarness();
    const drains = Object.values(jobStops(harness)).map((stop) => {
      const drain = deferred<undefined>();
      stop.mockReturnValueOnce(drain.promise);
      return drain;
    });
    const server = createTestServer(harness.application);

    const stopping = server.stop();
    await vi.waitFor(() => expect(harness.services.rateLimiter.stop).toHaveBeenCalledOnce());
    // Settle in reverse so the last drain to finish is the first one signalled.
    const [first, ...rest] = drains;
    for (const drain of rest.reverse()) {
      drain.resolve(undefined);
      await new Promise((resolve) => setImmediate(resolve));
      expect(harness.lifecycle.database.$disconnect).not.toHaveBeenCalled();
    }
    first?.resolve(undefined);
    await stopping;
    expect(harness.lifecycle.database.$disconnect).toHaveBeenCalledOnce();
  });

  it('keeps Git state and the event collector live until their upstream drains settle', async () => {
    const harness = createTestHarness();
    const prSync = deferred<undefined>();
    const snapshots = deferred<undefined>();
    vi.mocked(harness.services.schedulerService.stop).mockReturnValueOnce(prSync.promise);
    vi.mocked(harness.lifecycle.snapshotReconciliation.stop).mockReturnValueOnce(snapshots.promise);
    const server = createTestServer(harness.application);

    const stopping = server.stop();
    await vi.waitFor(() => expect(harness.services.rateLimiter.stop).toHaveBeenCalledOnce());
    expect(harness.lifecycle.eventCollector.stop).not.toHaveBeenCalled();
    prSync.resolve(undefined);
    await vi.waitFor(() => expect(harness.lifecycle.eventCollector.stop).toHaveBeenCalledOnce());
    expect(harness.services.workspaceGitStateService.stop).not.toHaveBeenCalled();
    snapshots.resolve(undefined);
    await stopping;
    expect(harness.services.workspaceGitStateService.stop).toHaveBeenCalledOnce();
  });
});
