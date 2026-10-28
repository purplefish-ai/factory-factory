import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { vi } from 'vitest';
import type {
  AgentSessionRecord,
  ProviderIdentityExpectation,
} from '@/backend/services/session/resources/agent-session.accessor';
import { AcpRuntimeConfigController } from '@/backend/services/session/service/acp/acp-runtime-config-controller';
import { createTestProcessHandle } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { configOptions } from './session-config-authority.test-helpers';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';
import { SessionConfigService } from './session.config.service';
import { SessionRepository } from './session.repository';

export function startupConfigOptions(
  model = 'first',
  mode = 'workspace-write'
): SessionConfigOption[] {
  return configOptions(model, mode).map((option) =>
    option.id === 'mode' && option.type === 'select'
      ? {
          ...option,
          options: ['read-only', 'workspace-write', 'agent', 'agent-full-access'].map((value) => ({
            value,
            name: value,
          })),
        }
      : option
  );
}

export function setupStartupConfig() {
  const h = createLifecycleHarness({
    provider: 'CODEX',
    providerSessionId: 'thread',
    getPermissionPreset: () => Promise.resolve('STRICT'),
  });
  let row = { ...structuredClone(h.session), updatedAt: new Date(1) };
  const hooks = {
    cas: (_number: number, _data: Partial<AgentSessionRecord>): Promise<void> => Promise.resolve(),
  };
  let writes = 0;
  const accessor = {
    findById: vi.fn(() => Promise.resolve(structuredClone(row))),
    update: vi.fn((_id: string, data: Partial<AgentSessionRecord>) => {
      row = { ...row, ...structuredClone(data), updatedAt: new Date(row.updatedAt.getTime() + 1) };
      return Promise.resolve(structuredClone(row));
    }),
    updateIfProviderIdentity: vi.fn(
      async (
        _id: string,
        expected: ProviderIdentityExpectation,
        data: Partial<AgentSessionRecord>
      ) => {
        await hooks.cas(++writes, data);
        if (
          expected.providerSessionId !== row.providerSessionId ||
          expected.updatedAt.getTime() !== row.updatedAt.getTime() ||
          JSON.stringify(expected.providerMetadata) !== JSON.stringify(row.providerMetadata)
        ) {
          return 0;
        }
        row = {
          ...row,
          ...structuredClone(data),
          updatedAt: new Date(row.updatedAt.getTime() + 1),
        };
        return 1;
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
  const handle = createTestProcessHandle({
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
  const fail = vi.spyOn(handle, 'failConfiguration');
  const controller = new AcpRuntimeConfigController();
  const runtime = {
    ...h.runtimeManager,
    setConfigOption: vi.fn((id: string, key: string, value: string) =>
      controller.setConfigOption(handle, key, value, id)
    ),
    setSessionMode: vi.fn((id: string, value: string) =>
      controller.setSessionMode(handle, value, id)
    ),
  };
  h.runtimeManager.getOrCreateClient.mockImplementation((_id, _options, handlers) => {
    handlers.onRuntimeCreated?.(handle);
    h.runtimeManager.getClient.mockReturnValue(handle);
    return Promise.resolve(handle);
  });
  const config = new SessionConfigService({
    repository,
    runtimeManager: unsafeCoerce(runtime),
    sessionDomainService: unsafeCoerce(h.sessionDomainService),
    codexModelCatalogService: { getModels: () => Promise.resolve([]) },
  });
  h.sessionConfigService.applyConfiguredPermissionPreset.mockImplementation(
    config.applyConfiguredPermissionPreset.bind(config)
  );
  h.sessionConfigService.persistAcpConfigSnapshot.mockImplementation(
    config.persistAcpConfigSnapshot.bind(config)
  );
  return {
    ...h,
    handle,
    complete,
    fail,
    controller,
    runtime,
    config,
    hooks,
    accessor,
    row: () => structuredClone(row),
    setSession: (data: Partial<AgentSessionRecord>) => {
      row = { ...row, ...structuredClone(data) };
      Object.assign(h.session, structuredClone(data));
    },
    native: (model = 'second', mode = 'workspace-write') =>
      config.applyConfigOptionsUpdateDelta(h.session.id, handle, startupConfigOptions(model, mode)),
  };
}
