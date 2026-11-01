import { afterEach, expect, it, vi } from 'vitest';
import { AcpClientFactory } from '@/backend/services/session/service/acp/acp-client-factory';
import { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';

afterEach(() => vi.restoreAllMocks());
it.each(['configuration', 'persistence'] as const)(
  'rejects event startup after %s failure without joining its own creation barrier',
  async (boundary) => {
    const manager = new AcpRuntimeManager();
    const handle = createTestProcessHandle({ provider: 'CLAUDE' });
    handle.ownedProcessGroup = handle.child.pid;
    handle.eventLifecycleGeneration = 0;
    vi.spyOn(AcpClientFactory.prototype, 'createClient').mockResolvedValue(handle);
    let live = true;
    const signal = vi.spyOn(process, 'kill').mockImplementation((_pid, value) => {
      if (!live) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
      if (value === 'SIGTERM') {
        live = false;
      }
      return true;
    });
    const h = createLifecycleHarness();
    h.runtimeManager.getClient.mockImplementation((id) => manager.getClient(id));
    h.runtimeManager.getOrCreateClient.mockImplementation((id, options, handlers, context) =>
      manager.getOrCreateClient(id, { ...options, ownedProcessGroup: true }, handlers, context)
    );
    h.runtimeManager.runClientCreationOperation.mockImplementation((...args) =>
      manager.runClientCreationOperation(...args)
    );
    h.runtimeManager.stopClient.mockImplementation((id) => manager.stopClient(id));
    if (boundary === 'configuration') {
      h.sessionConfigService.applyStartupModel.mockRejectedValue(new Error('configuration failed'));
    } else {
      h.sessionConfigService.completeStartupConfiguration.mockRejectedValue(
        new Error('persistence failed')
      );
    }
    const startup = h.service.getOrCreateSessionClient(h.session.id).then(
      () => 'unexpected success',
      (error: unknown) => error
    );
    const result = await Promise.race([
      startup,
      new Promise<string>((resolve) => setTimeout(() => resolve('self-wait'), 150)),
    ]);
    expect(result).toBeInstanceOf(Error);
    expect(manager.hasClientCreationOperation(h.session.id)).toBe(false);
    expect(signal).toHaveBeenCalledWith(-handle.child.pid!, 'SIGTERM');
    expect(manager.getClient(h.session.id)).toBeUndefined();
  }
);
