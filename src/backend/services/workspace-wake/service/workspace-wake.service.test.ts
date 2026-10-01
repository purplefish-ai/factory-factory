import type { WorkspaceWakeSchedule } from '@prisma-gen/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { createLogger } from '@/backend/services/logger.service';
import type {
  WorkspaceWakeDeliveryBridge,
  WorkspaceWakeScheduleBridge,
} from './workspace-wake.service';
import { WorkspaceWakeService } from './workspace-wake.service';

type Logger = ReturnType<typeof createLogger>;
const logger = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const DISPATCHED_AT = new Date('2026-05-20T12:00:00.000Z');

function schedule(overrides: Partial<WorkspaceWakeSchedule> = {}): WorkspaceWakeSchedule {
  return {
    workspaceId: 'ws-1',
    enabled: true,
    cadence: 'DAILY',
    prompt: 'Check the logs',
    scheduledTime: null,
    timezone: null,
    scheduledDayOfMonth: null,
    nextWakeAt: new Date('2026-05-20T12:00:00.000Z'),
    lastWakeAt: null,
    lastOutcome: null,
    lastError: null,
    ...overrides,
  };
}

function runCycle(
  service: WorkspaceWakeService,
  signal: AbortSignal = new AbortController().signal
) {
  const method = Reflect.get(service, 'runCycle') as (s: AbortSignal) => Promise<void>;
  return method.call(service, signal);
}

describe('WorkspaceWakeService', () => {
  let scheduleBridge: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    findDue: ReturnType<typeof vi.fn>;
    markDispatched: ReturnType<typeof vi.fn>;
    recordOutcome: ReturnType<typeof vi.fn>;
  };
  let deliveryBridge: { deliver: ReturnType<typeof vi.fn> };
  let service: WorkspaceWakeService;

  beforeEach(() => {
    vi.clearAllMocks();
    scheduleBridge = {
      get: vi.fn(),
      set: vi.fn(),
      clear: vi.fn(),
      findDue: vi.fn().mockResolvedValue([]),
      markDispatched: vi.fn().mockResolvedValue(DISPATCHED_AT),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    deliveryBridge = { deliver: vi.fn().mockResolvedValue({ delivered: true }) };
    service = new WorkspaceWakeService(logger);
    service.configure({
      schedule: scheduleBridge as unknown as WorkspaceWakeScheduleBridge,
      delivery: deliveryBridge as unknown as WorkspaceWakeDeliveryBridge,
    });
  });

  it('delegates get/set/clear to the schedule bridge', async () => {
    await service.get('ws-1');
    expect(scheduleBridge.get).toHaveBeenCalledWith('ws-1');

    await service.set('ws-1', { cadence: 'DAILY', prompt: 'hi' });
    expect(scheduleBridge.set).toHaveBeenCalledWith('ws-1', { cadence: 'DAILY', prompt: 'hi' });

    await service.clear('ws-1');
    expect(scheduleBridge.clear).toHaveBeenCalledWith('ws-1');
  });

  it('does nothing when there are no due schedules', async () => {
    await runCycle(service);
    expect(scheduleBridge.markDispatched).not.toHaveBeenCalled();
    expect(deliveryBridge.deliver).not.toHaveBeenCalled();
  });

  it('claims a due schedule, delivers the wake, and records success', async () => {
    scheduleBridge.findDue.mockResolvedValue([schedule()]);

    await runCycle(service);
    // Delivery is detached (fire-and-forget) from the poll cycle, so flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduleBridge.markDispatched).toHaveBeenCalledWith(schedule());
    expect(deliveryBridge.deliver).toHaveBeenCalledWith('ws-1', 'Check the logs');
    expect(scheduleBridge.recordOutcome).toHaveBeenCalledWith('ws-1', DISPATCHED_AT, {
      outcome: 'DELIVERED',
    });
  });

  it('records SKIPPED_NO_SESSION when delivery finds nothing to wake', async () => {
    scheduleBridge.findDue.mockResolvedValue([schedule()]);
    deliveryBridge.deliver.mockResolvedValue({ delivered: false });

    await runCycle(service);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduleBridge.recordOutcome).toHaveBeenCalledWith('ws-1', DISPATCHED_AT, {
      outcome: 'SKIPPED_NO_SESSION',
    });
  });

  it('records FAILED with the error message when delivery throws', async () => {
    scheduleBridge.findDue.mockResolvedValue([schedule()]);
    deliveryBridge.deliver.mockRejectedValue(new Error('boom'));

    await runCycle(service);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduleBridge.recordOutcome).toHaveBeenCalledWith('ws-1', DISPATCHED_AT, {
      outcome: 'FAILED',
      error: 'boom',
    });
  });

  it('does not deliver when another poll cycle already claimed the schedule', async () => {
    scheduleBridge.findDue.mockResolvedValue([schedule()]);
    scheduleBridge.markDispatched.mockResolvedValue(null);

    await runCycle(service);

    expect(deliveryBridge.deliver).not.toHaveBeenCalled();
  });

  it('stops processing further due schedules once the signal aborts', async () => {
    const controller = new AbortController();
    scheduleBridge.findDue.mockResolvedValue([
      schedule({ workspaceId: 'ws-1' }),
      schedule({ workspaceId: 'ws-2' }),
    ]);
    scheduleBridge.markDispatched.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(DISPATCHED_AT);
    });

    await runCycle(service, controller.signal);

    expect(scheduleBridge.markDispatched).toHaveBeenCalledTimes(1);
  });

  it('logs and does not throw when findDue rejects', async () => {
    scheduleBridge.findDue.mockRejectedValue(new Error('db unavailable'));

    await expect(runCycle(service)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('Workspace wake poll error', expect.any(Error));
    expect(scheduleBridge.markDispatched).not.toHaveBeenCalled();
  });

  it('stop() waits for an in-flight detached delivery to finish', async () => {
    scheduleBridge.findDue.mockResolvedValue([schedule()]);
    let resolveDelivery!: (result: { delivered: boolean }) => void;
    deliveryBridge.deliver.mockReturnValue(
      new Promise((resolve) => {
        resolveDelivery = resolve;
      })
    );

    await runCycle(service);

    let stopped = false;
    const stopPromise = service.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);

    resolveDelivery({ delivered: true });
    await stopPromise;
    expect(stopped).toBe(true);
    expect(scheduleBridge.recordOutcome).toHaveBeenCalledWith('ws-1', DISPATCHED_AT, {
      outcome: 'DELIVERED',
    });
  });

  it('warns and does nothing when the bridges are not configured', async () => {
    const unconfigured = new WorkspaceWakeService(logger);

    await expect(runCycle(unconfigured)).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'Workspace wake service not configured — skipping poll'
    );
    expect(scheduleBridge.findDue).not.toHaveBeenCalled();
  });
});
