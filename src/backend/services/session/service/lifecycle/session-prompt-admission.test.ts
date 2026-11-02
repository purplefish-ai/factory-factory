import { expect, it, vi } from 'vitest';
import {
  createDeferred,
  createTestProcessHandle,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { PromptConfigurationPermit } from '../acp/acp-prompt-configuration';
import { SessionConfigMutationQueue } from './session-config-mutation-queue';
import { SessionService, type SessionServiceDependencies } from './session.service';

it.each([false, true])(
  'keeps ordinary sends outside the prompt limiter while a durable configuration boundary owns admission (shared admission: %s)',
  async (sharedAdmission) => {
    const handle = createTestProcessHandle();
    const observed: string[] = [];
    const runtime = {
      getClient: () => handle,
      isStopInProgress: () => false,
      isSessionWorking: () => false,
      sendPrompt: async (
        _id: string,
        content: { text: string }[],
        _timeout: number,
        _observed: unknown,
        _guard: unknown,
        permit?: PromptConfigurationPermit
      ) => {
        if (!permit) {
          await handle.pendingConfigUpdates;
        }
        observed.push(content[0]?.text ?? '');
        return { stopReason: 'end_turn' };
      },
    };
    const queue = new SessionConfigMutationQueue(runtime, vi.fn());
    const service = new SessionService(
      unsafeCoerce<SessionServiceDependencies>({
        runtimeManager: runtime,
        admitPrompt: sharedAdmission
          ? <T>(id: string, send: (permit: PromptConfigurationPermit) => Promise<T>) =>
              queue.runPrompt(id, send)
          : undefined,
        sessionDomainService: { setRuntimeSnapshot: vi.fn() },
        acpEventProcessor: {
          getWorkspaceId: () => undefined,
          beginPromptTurn: () => 'turn',
          finishPromptTurn: vi.fn(),
          finalizeOrphanedToolCalls: vi.fn(),
        },
        promptTurnCompletionService: { schedule: vi.fn() },
        lifecycleGate: {
          getGeneration: () => 0,
          isGenerationCurrent: () => true,
          isSessionStopping: () => false,
        },
      })
    );
    const claiming = createDeferred<void>();
    const entered = createDeferred<void>();
    const prompt = queue.runPrompt('session', async (permit) => {
      entered.resolve();
      await claiming.promise;
      await service.sendSessionMessage('session', 'admitted', undefined, permit);
    });
    await entered.promise;
    const edit = queue.run('session', async () => undefined);
    const ordinary = service.sendSessionMessage('session', 'ordinary');
    claiming.resolve();
    await vi.waitFor(() => expect(observed).toEqual(['admitted', 'ordinary']), { timeout: 500 });
    await Promise.all([prompt, edit, ordinary]);
  }
);
