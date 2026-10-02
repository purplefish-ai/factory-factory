import { describe, expect, it, vi } from 'vitest';
import { type BridgeServices, configureDomainBridges } from './domain-bridges.orchestrator';

/**
 * configureDomainBridges wires ~40 domain services in one pass; every
 * property this test doesn't care about resolves to a vi.fn()-backed stub
 * (callable, and returning further stubs for property access), since those
 * other bridges only register callbacks with each service's `.configure()`
 * at setup time — none of their logic runs here. Avoids duplicating
 * domain-bridges.orchestrator.test.ts's full mock setup just to cover the
 * workspace wake bridge.
 */
function createStubBridgeServices(overrides: Record<string, unknown>): BridgeServices {
  const autoStub = new Proxy(vi.fn(), { get: () => autoStub });
  return new Proxy(
    {},
    { get: (_target, prop: string) => (prop in overrides ? overrides[prop] : autoStub) }
  ) as unknown as BridgeServices;
}

function getBridge<T>(mockFn: (arg: T) => void): T {
  return vi.mocked(mockFn).mock.calls[0]![0];
}

describe('configureDomainBridges — workspace wake bridge', () => {
  it('delegates schedule and delivery calls to the wake services', async () => {
    const scheduleMock = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      findDue: vi.fn().mockResolvedValue([]),
      markDispatched: vi.fn().mockResolvedValue(null),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    const deliverWorkspaceWake = vi.fn().mockResolvedValue({ delivered: true });
    const workspaceWakeServiceConfigure = vi.fn();

    configureDomainBridges(
      createStubBridgeServices({
        deliverWorkspaceWake,
        workspaceWakeScheduleService: scheduleMock,
        workspaceWakeService: { configure: workspaceWakeServiceConfigure },
      })
    );
    const bridge = getBridge(workspaceWakeServiceConfigure);

    await bridge.schedule.get('ws-1');
    await bridge.schedule.set('ws-1', { cadence: 'DAILY', prompt: 'check logs' });
    await bridge.schedule.clear('ws-1');
    await bridge.schedule.findDue();
    await bridge.schedule.markDispatched({} as never);
    await bridge.schedule.recordOutcome('ws-1', new Date(0), { outcome: 'DELIVERED' });
    await bridge.delivery.deliver('ws-1', 'check logs');

    expect(scheduleMock.get).toHaveBeenCalledWith('ws-1');
    expect(scheduleMock.set).toHaveBeenCalledWith('ws-1', {
      cadence: 'DAILY',
      prompt: 'check logs',
    });
    expect(scheduleMock.clear).toHaveBeenCalledWith('ws-1');
    expect(scheduleMock.findDue).toHaveBeenCalled();
    expect(scheduleMock.markDispatched).toHaveBeenCalled();
    expect(scheduleMock.recordOutcome).toHaveBeenCalled();
    expect(deliverWorkspaceWake).toHaveBeenCalledWith('ws-1', 'check logs');
  });
});
