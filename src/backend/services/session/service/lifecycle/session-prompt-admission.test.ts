import { expect, it, vi } from 'vitest';
import type { PromptConfigurationPermit } from '@/backend/services/session/service/acp/acp-prompt-configuration';
import {
  createManagerTestHarness,
  setupSuccessfulSpawn,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-harness';
import {
  defaultOptions,
  defaultHandlers,
  defaultContext,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import {
  createDeferred,
  createTestProcessHandle,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigMutationQueue } from './session-config-mutation-queue';
import { SessionPermissionService } from './session.permission.service';
import { SessionService, type SessionServiceDependencies } from './session.service';

it.each([false, true])(
  'keeps ordinary sends outside the prompt limiter while a durable configuration boundary owns admission (shared admission: %s)',
  async (sharedAdmission) => {
    const handle = createTestProcessHandle();
    const observed: string[] = [];
    const runtimeEntries: string[] = [];
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
        runtimeEntries.push(content[0]?.text ?? '');
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
    const editEntered = createDeferred<void>();
    const finishEdit = createDeferred<void>();
    const edit = queue.run('session', async () => {
      editEntered.resolve();
      await finishEdit.promise;
    });
    const ordinary = service.sendSessionMessage('session', 'ordinary');
    claiming.resolve();
    await editEntered.promise;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runtimeEntries).toEqual(sharedAdmission ? ['admitted'] : ['admitted', 'ordinary']);
    } finally {
      finishEdit.resolve();
    }
    await vi.waitFor(() => expect(observed).toEqual(['admitted', 'ordinary']), { timeout: 500 });
    await Promise.all([prompt, edit, ordinary]);
  }
);

it('fences an ordinary send accepted before stop even if admission resumes on a later generation', async () => {
  const handle = createTestProcessHandle();
  const release = createDeferred<void>();
  const entered = createDeferred<void>();
  let generation = 0;
  const sendPrompt = vi.fn(() => Promise.resolve({ stopReason: 'end_turn' }));
  const service = new SessionService(
    unsafeCoerce<SessionServiceDependencies>({
      runtimeManager: { getClient: () => handle, sendPrompt, isSessionWorking: () => false },
      sessionDomainService: { setRuntimeSnapshot: vi.fn() },
      acpEventProcessor: {
        getWorkspaceId: () => undefined,
        beginPromptTurn: () => 'turn',
        finishPromptTurn: vi.fn(),
        finalizeOrphanedToolCalls: vi.fn(),
      },
      promptTurnCompletionService: { schedule: vi.fn() },
      lifecycleGate: {
        getGeneration: () => generation,
        isGenerationCurrent: (_id: string, candidate: number) => candidate === generation,
        isSessionStopping: () => false,
      },
      admitPrompt: async <T>(
        _id: string,
        send: (permit: PromptConfigurationPermit) => Promise<T>
      ) => {
        entered.resolve();
        await release.promise;
        return send({
          provider: handle.provider,
          providerSessionId: handle.providerSessionId,
          configOptions: () => [],
          assertCurrent: () => undefined,
        });
      },
    })
  );
  const pending = service.sendSessionMessage('session', 'old generation');
  await entered.promise;
  generation++;
  const rejected = expect(pending).rejects.toThrow(
    'Session lifecycle changed before prompt dispatch'
  );
  release.resolve();
  await rejected;
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('uses the real prompt limiter and ACP runtime across frozen claim, later edit, direct sender and permission reply', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const handle = await manager.getOrCreateClient(
    'session',
    defaultOptions(),
    defaultHandlers(),
    defaultContext()
  );
  handle.configOptions = [
    {
      id: 'model',
      category: 'model',
      type: 'select',
      name: 'Model',
      currentValue: 'first',
      options: [
        { value: 'first', name: 'First' },
        { value: 'second', name: 'Second' },
      ],
    },
  ];
  handle.configOptions.push({
    id: 'mode',
    category: 'mode',
    type: 'select',
    name: 'Mode',
    currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }],
  });
  vi.spyOn(handle.connection, 'setSessionConfigOption').mockImplementation(({ configId, value }) =>
    Promise.resolve({
      configOptions: handle.configOptions.map((option) =>
        option.id === configId && option.type === 'select' && typeof value === 'string'
          ? { ...option, currentValue: value }
          : option
      ),
    })
  );
  const queue = new SessionConfigMutationQueue(manager, vi.fn());
  const domain = new SessionDomainService();
  const permissions = new SessionPermissionService({ sessionDomainService: domain });
  const bridge = permissions.createPermissionBridge('session');
  const approval = bridge.waitForUserResponse('permission', {
    sessionId: handle.acpSessionId,
    toolCall: { toolCallId: 'tool', title: 'Edit' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });
  const observed: { text: string; model: unknown }[] = [];
  vi.spyOn(handle.connection, 'prompt').mockImplementation(async ({ prompt }) => {
    const text = prompt.find((block) => block.type === 'text');
    observed.push({
      text: text?.type === 'text' ? text.text : '',
      model: handle.configOptions[0]?.currentValue,
    });
    if (observed.length === 1) {
      await approval;
    }
    return { stopReason: 'end_turn' };
  });
  const service = new SessionService(
    unsafeCoerce<SessionServiceDependencies>({
      runtimeManager: manager,
      admitPrompt: <T>(id: string, send: (permit: PromptConfigurationPermit) => Promise<T>) =>
        queue.runPrompt(id, send),
      sessionDomainService: domain,
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
  let frozen: unknown;
  const a = queue.runPrompt('session', async (permit) => {
    frozen = permit.configOptions()[0]?.currentValue;
    entered.resolve();
    await claiming.promise;
    await service.sendSessionMessage('session', 'A', undefined, permit);
  });
  await entered.promise;
  let editSettled = false;
  const b = queue
    .run('session', () => manager.setSessionModel('session', 'second'))
    .then(() => {
      editSettled = true;
    });
  const c = service.sendSessionMessage('session', 'C');
  claiming.resolve();
  await vi.waitFor(() => expect(observed).toEqual([{ text: 'A', model: frozen }]));
  expect(editSettled).toBe(false);
  expect(permissions.respondToPermission('session', 'permission', 'allow')).toBe(true);
  await Promise.all([a, b, c]);
  expect(observed).toEqual([
    { text: 'A', model: 'first' },
    { text: 'C', model: 'second' },
  ]);
});
