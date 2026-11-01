import { afterEach, expect, it, vi } from 'vitest';
import { AcpClientFactory } from '@/backend/services/session/service/acp/acp-client-factory';
import { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import type { InitialDeliveryFence } from '@/shared/event-agent-delivery';
import { EventSessionAuthority } from './event-session-authority';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';

afterEach(() => vi.restoreAllMocks());
it.skipIf(process.platform === 'win32').each(['configuration', 'persistence'] as const)(
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
    const fence: InitialDeliveryFence = {
      attempt: {
        runId: 'run',
        sessionId: 'session-1',
        messageId: 'message',
        sendAttemptId: 'send',
        workerGeneration: 1,
        attemptGeneration: 1,
      },
      state: 'PENDING',
      execution: {
        version: 1,
        provider: 'CLAUDE',
        model: 'sonnet',
        reasoningEffort: null,
        codexAccountId: null,
        startupModePreset: 'non_interactive',
        accessMode: 'bypassPermissions',
        planModeEnabled: false,
      },
      evidence: null,
    };
    const authority = new EventSessionAuthority(async () => ({
      runId: 'run',
      execution: fence.execution,
    }));
    const readFence = vi.fn(async () => fence);
    authority.configure({
      readFence,
      beforeSend: async () => undefined,
      outcome: async () => undefined,
      ambiguous: async () => undefined,
      stop: async () => undefined,
    });
    const h = createLifecycleHarness({ eventAuthority: authority });
    h.runtimeManager.getClient.mockImplementation((id) => manager.getClient(id));
    h.runtimeManager.getOrCreateClient.mockImplementation((id, options, handlers, context) =>
      manager.getOrCreateClient(id, options, handlers, context)
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
    const startup = authority
      .runInitial(fence.attempt, (permit) =>
        h.service.getOrCreateSessionClient(h.session.id, { eventInitial: permit })
      )
      .then(
        () => 'unexpected success',
        (error: unknown) => error
      );
    const result = await Promise.race([
      startup,
      new Promise<string>((resolve) => setTimeout(() => resolve('self-wait'), 150)),
    ]);
    expect(result).toBeInstanceOf(Error);
    expect(result).toMatchObject({
      message: boundary === 'configuration' ? 'configuration failed' : 'persistence failed',
    });
    expect(h.runtimeManager.getOrCreateClient).toHaveBeenCalledWith(
      h.session.id,
      expect.objectContaining({ ownedProcessGroup: true }),
      expect.anything(),
      expect.anything()
    );
    expect(readFence).toHaveBeenCalled();
    expect(h.sessionConfigService.applyStartupModel).toHaveBeenCalled();
    if (boundary === 'persistence') {
      expect(h.sessionConfigService.completeStartupConfiguration).toHaveBeenCalled();
    }
    expect(manager.hasClientCreationOperation(h.session.id)).toBe(false);
    expect(signal).toHaveBeenCalledWith(-handle.child.pid!, 'SIGTERM');
    expect(manager.getClient(h.session.id)).toBeUndefined();
  }
);
