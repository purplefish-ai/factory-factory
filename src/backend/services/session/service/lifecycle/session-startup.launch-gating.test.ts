import { describe, expect, it } from 'vitest';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';
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
    expect(h.sessionConfigService.persistAcpConfigSnapshot).not.toHaveBeenCalled();
  });
  it('keeps startup unready and does not prompt when final persistence fails', async () => {
    const h = createLifecycleHarness({
      session: {
        providerMetadata: {
          launchSettings: { reasoningEffort: 'high', planModeEnabled: true, applied: false },
        },
      },
    });
    h.sessionConfigService.persistAcpConfigSnapshot.mockRejectedValue(
      new Error('Final persistence unavailable')
    );
    await expect(
      h.service.startSession('session-1', { initialPrompt: 'First prompt' })
    ).rejects.toThrow('Final persistence unavailable');
    expect(h.sessionConfigService.persistAcpConfigSnapshot).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ requirePersistence: true })
    );
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
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
    expect(h.sessionConfigService.persistAcpConfigSnapshot).toHaveBeenLastCalledWith(
      'session-1',
      expect.objectContaining({
        existingMetadata: expect.objectContaining({
          launchSettings: { reasoningEffort: 'high', planModeEnabled: true, applied: true },
        }),
      })
    );
    expect(h.sessionConfigService.applyStartupLaunchPlan.mock.invocationCallOrder[0]).toBeLessThan(
      h.sessionConfigService.persistAcpConfigSnapshot.mock.invocationCallOrder[0] ?? 0
    );
  });
});
