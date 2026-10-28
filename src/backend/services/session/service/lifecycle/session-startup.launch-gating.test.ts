import { describe, expect, it, vi } from 'vitest';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';
vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(() => Promise.resolve([])),
    findForDelivery: vi.fn(() => Promise.resolve(null)),
    markDelivered: vi.fn(() => Promise.resolve()),
  },
}));

describe('launch configuration startup gate', () => {
  it('does not prompt or consume intent when explicit Plan application fails', async () => {
    const h = createLifecycleHarness({
      session: {
        providerMetadata: {
          launchSettings: { reasoningEffort: 'high', planModeEnabled: true, applied: false },
        },
      },
    });
    h.sessionConfigService.applyStartupLaunchPlan.mockRejectedValue(new Error('Plan rejected'));
    await expect(
      h.service.startSession('session-1', { initialPrompt: 'First prompt' })
    ).rejects.toThrow('Plan rejected');
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
    expect(h.handle.completeConfiguration).not.toHaveBeenCalled();
    expect(h.handle.failConfiguration).toHaveBeenCalledWith(expect.any(Error));
    expect(h.sessionConfigService.completeStartupConfiguration).not.toHaveBeenCalled();
  });
  it('keeps startup unready and does not prompt when final persistence fails', async () => {
    const h = createLifecycleHarness({
      session: {
        providerMetadata: {
          launchSettings: { reasoningEffort: 'high', planModeEnabled: true, applied: false },
        },
      },
    });
    h.sessionConfigService.completeStartupConfiguration.mockRejectedValue(
      new Error('Final persistence unavailable')
    );
    await expect(
      h.service.startSession('session-1', { initialPrompt: 'First prompt' })
    ).rejects.toThrow('Final persistence unavailable');
    expect(h.sessionConfigService.completeStartupConfiguration).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        handle: h.handle,
        assertCurrent: expect.any(Function),
        beforeComplete: expect.any(Function),
        complete: expect.any(Function),
      })
    );
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
    expect(h.handle.completeConfiguration).not.toHaveBeenCalled();
    expect(h.handle.failConfiguration).toHaveBeenCalledWith(expect.any(Error));
  });
  it('marks intent applied only on the final configuration snapshot', async () => {
    const h = createLifecycleHarness({
      session: {
        providerMetadata: {
          launchSettings: { reasoningEffort: 'high', planModeEnabled: true, applied: false },
        },
      },
    });
    await h.service.startSession('session-1', { initialPrompt: '' });
    expect(h.sessionConfigService.completeStartupConfiguration).toHaveBeenCalledTimes(1);
    expect(h.sessionConfigService.completeStartupConfiguration).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({
        intent: expect.objectContaining({
          launch: { reasoningEffort: 'high', planModeEnabled: true, applied: false },
        }),
      })
    );
    expect(h.sessionConfigService.applyStartupLaunchPlan.mock.invocationCallOrder[0]).toBeLessThan(
      h.sessionConfigService.completeStartupConfiguration.mock.invocationCallOrder[0] ?? 0
    );
  });
});
