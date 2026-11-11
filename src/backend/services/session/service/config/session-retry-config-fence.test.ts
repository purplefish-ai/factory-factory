import { expect, it, vi } from 'vitest';
import { AcpClientFactory } from '@/backend/services/session/service/acp/acp-client-factory';
import { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import {
  codexOptions,
  createTestProcessHandle,
  defaultContext,
  defaultHandlers,
  exitChildAfterSigterm,
  type MockChildProcess,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import type { SessionCallerGuard } from '@/backend/services/session/service/bridges';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { configOptions, gate, setupAuthority } from './session-config-authority.test-helpers';

it.each([
  ['queue', 'replacement'],
  ['model', 'replacement'],
  ['reasoning', 'replacement'],
  ['model', 'stop'],
  ['reasoning', 'stop'],
  ['model', 'configuration'],
  ['reasoning', 'configuration'],
  ['model', 'current'],
  ['reasoning', 'current'],
] as const)(
  'fences captured %s configuration across a caller wait: %s',
  async (boundary, change) => {
    const manager = new AcpRuntimeManager();
    const mockSetSessionConfigOption = vi.fn();
    const spawn = () => {
      const handle = createTestProcessHandle({
        provider: 'CODEX',
        providerSessionId: 'thread',
        connection: { setSessionConfigOption: mockSetSessionConfigOption },
      });
      exitChildAfterSigterm(unsafeCoerce<MockChildProcess>(handle.child));
      vi.spyOn(AcpClientFactory.prototype, 'createClient').mockResolvedValue(handle);
    };
    spawn();
    const handle = await manager.getOrCreateClient(
      'session',
      codexOptions(),
      defaultHandlers(),
      defaultContext()
    );
    handle.configOptions = configOptions('first');
    const h = setupAuthority(manager);
    const held = gate();
    let checks = 0;
    const guard: SessionCallerGuard = {
      check: async () => {
        checks += 1;
        // The queue checks first; each native option checks again at its setter.
        if (checks === (boundary === 'queue' ? 1 : 2)) {
          await held.wait();
        }
      },
      assertCurrent: () => undefined,
    };
    const before = mockSetSessionConfigOption.mock.calls.length;
    mockSetSessionConfigOption.mockImplementation(async ({ configId, value }) => ({
      configOptions: handle.configOptions.map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option
      ),
    }));
    const setting = h.service
      .configureQueuedMessage(
        'session',
        {
          timestamp: new Date().toISOString(),
          settings: {
            selectedModel: boundary === 'reasoning' ? null : 'second',
            reasoningEffort: boundary === 'reasoning' ? 'high' : null,
            thinkingEnabled: false,
            planModeEnabled: false,
          },
        },
        guard
      )
      .catch((error: unknown) => error);
    await held.started;
    let complete: () => void = () => undefined;
    if (change === 'replacement' || change === 'stop') {
      await manager.stopClient('session');
      if (change === 'replacement') {
        spawn();
        const replacement = await manager.getOrCreateClient(
          'session',
          codexOptions(),
          defaultHandlers(),
          defaultContext()
        );
        replacement.configOptions = configOptions('first');
      }
    } else if (change === 'configuration') {
      const configuration = handle.beginConfiguration();
      complete = () => configuration.complete();
    }
    held.release();
    const outcome = await setting;
    complete();
    await manager.stopAllClients(10);
    if (change === 'current') {
      expect(outcome).not.toBeInstanceOf(Error);
      expect(mockSetSessionConfigOption.mock.calls.length).toBeGreaterThan(before);
    } else {
      expect(mockSetSessionConfigOption.mock.calls.length).toBe(before);
      expect(outcome).toBeInstanceOf(Error);
    }
  }
);

it.each(['plan', 'reasoning'] as const)(
  'rejects guarded %s settings with no runtime while retaining ordinary behavior',
  async (kind) => {
    const manager = new AcpRuntimeManager();
    const h = setupAuthority(manager);
    const message = {
      timestamp: new Date().toISOString(),
      settings: {
        selectedModel: null,
        reasoningEffort: kind === 'reasoning' ? 'high' : null,
        thinkingEnabled: false,
        planModeEnabled: kind === 'plan',
      },
    };
    await expect(
      h.service.configureQueuedMessage('session', message, {
        check: async () => undefined,
        assertCurrent: () => undefined,
      })
    ).rejects.toThrow('Retry runtime is unavailable');
    await expect(h.service.configureQueuedMessage('session', message)).resolves.toEqual(
      message.settings
    );
  }
);
