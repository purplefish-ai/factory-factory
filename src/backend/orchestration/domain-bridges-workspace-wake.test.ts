import type { WorkspaceWakeSchedule } from '@prisma-gen/client';
import { describe, expect, it, vi } from 'vitest';
import { type BridgeServices, configureDomainBridges } from './domain-bridges.orchestrator';

/**
 * Narrow companion to `domain-bridges.orchestrator.test.ts`, which already
 * covers every other bridge via a full, deeply-mocked `BridgeServices`. That
 * file is a legacy oversized file under a shrink-only length ratchet
 * (`scripts/file-length-baseline.json`), so this suite builds its own minimal
 * `BridgeServices` stub rather than growing the shared one further.
 */

function workspaceWakeScheduleServiceStub() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    findDue: vi.fn(),
    markDispatched: vi.fn(),
    recordOutcome: vi.fn(),
  };
}

function minimalBridgeServices(overrides: Partial<BridgeServices> = {}): BridgeServices & {
  workspaceWakeScheduleService: ReturnType<typeof workspaceWakeScheduleServiceStub>;
  workspaceWakeService: { configure: ReturnType<typeof vi.fn> };
} {
  return {
    // Every other bridge configureDomainBridges wires: untested here, so just
    // enough shape for the unconditional `.configure(...)` calls to resolve.
    ratchetService: { configure: vi.fn() },
    fixerSessionService: { configure: vi.fn() },
    reconciliationService: { configure: vi.fn() },
    workspaceQueryService: { configure: vi.fn() },
    prSnapshotService: { configure: vi.fn() },
    chatEventForwarderService: { configure: vi.fn() },
    sessionService: { configure: vi.fn() },
    sessionLifecycleService: { configure: vi.fn() },
    chatMessageHandlerService: { configure: vi.fn() },
    startupScriptService: { configure: vi.fn() },
    autoIterationService: { configure: vi.fn() },
    periodicTaskService: { configure: vi.fn() },
    workspaceSnapshotStore: { configure: vi.fn() },
    sessionPromptTurnCompletionService: { setHandler: vi.fn() },
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    // The bridge under test.
    workspaceWakeScheduleService: workspaceWakeScheduleServiceStub(),
    workspaceWakeService: { configure: vi.fn() },
    deliverWorkspaceWake: vi.fn(),
    ...overrides,
  } as unknown as BridgeServices & {
    workspaceWakeScheduleService: ReturnType<typeof workspaceWakeScheduleServiceStub>;
    workspaceWakeService: { configure: ReturnType<typeof vi.fn> };
  };
}

function getBridge<T>(mockFn: (arg: T) => void): T {
  return vi.mocked(mockFn).mock.calls[0]![0];
}

describe('configureDomainBridges workspace wake bridge', () => {
  it('schedule bridge delegates to the injected workspaceWakeScheduleService', async () => {
    const services = minimalBridgeServices();
    configureDomainBridges(services);
    const bridge = getBridge(services.workspaceWakeService.configure);
    const schedule = { workspaceId: 'ws1' } as WorkspaceWakeSchedule;
    const dispatchedAt = new Date('2026-05-20T12:00:00.000Z');

    await bridge.schedule.get('ws1');
    await bridge.schedule.set('ws1', { cadence: 'DAILY', prompt: 'hi' });
    await bridge.schedule.clear('ws1');
    await bridge.schedule.findDue();
    await bridge.schedule.markDispatched(schedule);
    await bridge.schedule.recordOutcome('ws1', dispatchedAt, { outcome: 'DELIVERED' });

    const scheduleService = services.workspaceWakeScheduleService;
    expect(scheduleService.get).toHaveBeenCalledWith('ws1');
    expect(scheduleService.set).toHaveBeenCalledWith('ws1', { cadence: 'DAILY', prompt: 'hi' });
    expect(scheduleService.clear).toHaveBeenCalledWith('ws1');
    expect(scheduleService.findDue).toHaveBeenCalledTimes(1);
    expect(scheduleService.markDispatched).toHaveBeenCalledWith(schedule);
    expect(scheduleService.recordOutcome).toHaveBeenCalledWith('ws1', dispatchedAt, {
      outcome: 'DELIVERED',
    });
  });

  it('delivery bridge delegates to the injected deliverWorkspaceWake', async () => {
    const injectedDeliver = vi.fn().mockResolvedValue({ delivered: true });
    const services = minimalBridgeServices({ deliverWorkspaceWake: injectedDeliver });
    configureDomainBridges(services);
    const bridge = getBridge(services.workspaceWakeService.configure);

    await expect(bridge.delivery.deliver('ws1', 'wake up')).resolves.toEqual({
      delivered: true,
    });
    expect(injectedDeliver).toHaveBeenCalledWith('ws1', 'wake up');
  });
});
