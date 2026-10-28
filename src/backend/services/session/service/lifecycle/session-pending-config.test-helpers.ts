import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { vi } from 'vitest';
import type {
  AgentSessionRecord,
  ProviderIdentityExpectation,
} from '@/backend/services/session/resources/agent-session.accessor';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { createDeferred, createLifecycleHarness } from './session-lifecycle.test-helpers';
import { SessionRepository } from './session.repository';

export function startupConfigOptions(
  model = 'first',
  mode = 'workspace-write'
): SessionConfigOption[] {
  return [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: ['first', 'second', 'third'].map((value) => ({ value, name: value })),
    },
    {
      id: 'mode',
      category: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: mode,
      options: ['read-only', 'workspace-write', 'agent', 'agent-full-access'].map((value) => ({
        value,
        name: value,
      })),
    },
  ];
}

export function setupStartupConfig() {
  const h = createLifecycleHarness({
    provider: 'CODEX',
    providerSessionId: 'thread',
    session: { model: 'first' },
    getPermissionPreset: () => Promise.resolve('STRICT'),
  });
  let row = { ...structuredClone(h.session), updatedAt: new Date(1) };
  const accessor = {
    findById: vi.fn(() => Promise.resolve(structuredClone(row))),
    update: vi.fn((_id: string, data: Partial<AgentSessionRecord>) => {
      row = { ...row, ...structuredClone(data), updatedAt: new Date(row.updatedAt.getTime() + 1) };
      return Promise.resolve(structuredClone(row));
    }),
    updateIfProviderIdentity: vi.fn(
      (_id: string, expected: ProviderIdentityExpectation, data: Partial<AgentSessionRecord>) => {
        if (
          expected.providerSessionId !== row.providerSessionId ||
          expected.updatedAt.getTime() !== row.updatedAt.getTime() ||
          JSON.stringify(expected.providerMetadata) !== JSON.stringify(row.providerMetadata)
        ) {
          return Promise.resolve(0);
        }
        row = {
          ...row,
          ...structuredClone(data),
          updatedAt: new Date(row.updatedAt.getTime() + 1),
        };
        return Promise.resolve(1);
      }
    ),
  };
  const repository = new SessionRepository(
    unsafeCoerce(accessor),
    unsafeCoerce({
      findById: () => Promise.resolve(h.workspace),
      recordSessionPresence: () => Promise.resolve(),
    })
  );
  h.repository.getSessionById.mockImplementation(repository.getSessionById.bind(repository));
  h.repository.updateSession.mockImplementation(repository.updateSession.bind(repository));
  h.repository.acknowledgeStartupConfiguration.mockImplementation(
    repository.acknowledgeStartupConfiguration.bind(repository)
  );
  h.repository.updatePendingLaunchConfiguration.mockImplementation(
    repository.updatePendingLaunchConfiguration.bind(repository)
  );
  const handle = createTestProcessHandle({
    provider: 'CODEX',
    providerSessionId: 'thread',
    sessionCreationOutcome: { kind: 'resumed' },
    connection: unsafeCoerce({
      setSessionConfigOption: ({ configId, value }: { configId: string; value: string }) =>
        Promise.resolve({
          configOptions: handle.configOptions.map((option) =>
            option.id === configId ? { ...option, currentValue: value } : option
          ),
        }),
      setSessionMode: () => Promise.resolve({}),
    }),
  });
  handle.configOptions = startupConfigOptions();
  handle.deferPromptReadiness();
  const complete = vi.spyOn(handle, 'completeConfiguration');
  return {
    ...h,
    handle,
    complete,
    accessor,
    row: () => structuredClone(row),
  };
}

export function gate() {
  const started = createDeferred<void>();
  const released = createDeferred<void>();
  return {
    started: started.promise,
    release: () => released.resolve(),
    async wait() {
      started.resolve();
      await released.promise;
    },
  };
}
