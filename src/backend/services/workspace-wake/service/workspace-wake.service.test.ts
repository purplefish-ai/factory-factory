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

function schedule(overrides: Partial<Record<string, unknown>> = {}) {
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
      markDispatched: vi.fn().mockResolvedValue(true),
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
    expect(scheduleBridge.recordOutcome).toHaveBeenCalledWith('ws-1', { outcome: 'DELIVERED' });
  });

  it('records SKIPPED_NO_SESSION when delivery finds nothing to wake', async () => {
    scheduleBridge.findDue.mockResolvedValue([schedule()]);
    deliveryBridge.deliver.mockResolvedValue({ delivered: false });

    await runCycle(service);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduleBridge.recordOutcome).toHaveBeenCalledWith('ws-1', {
      outcome: 'SKIPPED_NO_SESSION',
    });
  });

  it('records FAILED with the error message when delivery throws', async () => {
    scheduleBridge.findDue.mockResolvedValue([schedule()]);
    deliveryBridge.deliver.mockRejectedValue(new Error('boom'));

    await runCycle(service);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduleBridge.recordOutcome).toHaveBeenCalledWith('ws-1', {
      outcome: 'FAILED',
      error: 'boom',
    });
  });

  it('does not deliver when another poll cycle already claimed the schedule', async () => {
    scheduleBridge.findDue.mockResolvedValue([schedule()]);
    scheduleBridge.markDispatched.mockResolvedValue(false);

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
      return Promise.resolve(true);
    });

    await runCycle(service, controller.signal);

    expect(scheduleBridge.markDispatched).toHaveBeenCalledTimes(1);
  });
});
