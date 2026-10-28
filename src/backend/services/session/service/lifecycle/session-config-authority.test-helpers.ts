import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { vi } from 'vitest';
import type {
  AgentSessionRecord,
  ProviderIdentityExpectation,
} from '@/backend/services/session/resources/agent-session.accessor';
import { AcpRuntimeConfigController } from '@/backend/services/session/service/acp/acp-runtime-config-controller';
import {
  createDeferred,
  createTestProcessHandle,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';
import { SessionRepository } from './session.repository';

export function configOptions(
  model: string,
  mode = 'default',
  effort = 'low',
  collaboration = 'default'
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
      options: ['default', 'read-only'].map((value) => ({ value, name: value })),
    },
    {
      id: 'collaboration_mode',
      category: 'collaboration_mode',
      name: 'Planning',
      type: 'select',
      currentValue: collaboration,
      options: ['default', 'plan'].map((value) => ({ value, name: value })),
    },
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      name: 'Reasoning',
      type: 'select',
      currentValue: effort,
      options: ['low', 'high'].map((value) => ({ value, name: value })),
    },
  ];
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

export async function settleConfig() {
  // The fake I/O resolves on microtasks; drain background snapshot continuations too.
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
  }
}

type Update = Partial<AgentSessionRecord>;
export function setupAuthority() {
  let row = unsafeCoerce<AgentSessionRecord>({
    id: 'session',
    provider: 'CODEX',
    providerSessionId: 'thread',
    workflow: 'code',
    model: 'first',
    providerMetadata: null,
    status: 'IDLE',
    updatedAt: new Date(1),
  });
  const otherRows = new Map<string, AgentSessionRecord>();
  const readRow = (id: string) => {
    const found = id === 'session' ? row : otherRows.get(id);
    if (!found) {
      throw new Error(`Missing test session: ${id}`);
    }
    return found;
  };
  const writeRow = (id: string, next: AgentSessionRecord) => {
    if (id === 'session') {
      row = next;
    } else {
      otherRows.set(id, next);
    }
  };
  let reads = 0;
  let writes = 0;
  const hooks = {
    read: (_number: number): Promise<void> => Promise.resolve(),
    cas: (_number: number, _expected: ProviderIdentityExpectation, _data: Update): Promise<void> =>
      Promise.resolve(),
  };
  const casModels: (string | undefined)[] = [];
  const accessor = {
    findById: vi.fn(async (id: string) => {
      await hooks.read(++reads);
      return structuredClone(readRow(id));
    }),
    updateIfProviderIdentity: vi.fn(
      async (id: string, expected: ProviderIdentityExpectation, data: Update) => {
        casModels.push(data.model ?? undefined);
        await hooks.cas(++writes, expected, data);
        const current = readRow(id);
        if (
          expected.providerSessionId !== current.providerSessionId ||
          expected.updatedAt?.getTime() !== current.updatedAt.getTime() ||
          JSON.stringify(expected.providerMetadata) !== JSON.stringify(current.providerMetadata)
        ) {
          return 0;
        }
        writeRow(id, {
          ...current,
          ...structuredClone(data),
          updatedAt: new Date(current.updatedAt.getTime() + 1),
        });
        return 1;
      }
    ),
    update: vi.fn((id: string, data: Update) => {
      const current = readRow(id);
      writeRow(id, {
        ...current,
        ...structuredClone(data),
        updatedAt: new Date(current.updatedAt.getTime() + 1),
      });
      return Promise.resolve(structuredClone(readRow(id)));
    }),
  };
  const repository = new SessionRepository(unsafeCoerce(accessor), unsafeCoerce({}));
  const controller = new AcpRuntimeConfigController();
  const connection = {
    setSessionConfigOption: vi.fn(
      async ({ configId, value }: { configId: string; value: string }) => ({
        configOptions: handle.configOptions.map((option) =>
          option.id === configId ? { ...option, currentValue: value } : option
        ),
      })
    ),
    setSessionMode: vi.fn(async () => ({})),
  };
  const handle = createTestProcessHandle({
    providerSessionId: 'thread',
    connection: unsafeCoerce(connection),
  });
  handle.configOptions = configOptions('first');
  const handles = new Map([['session', handle]]);
  const requireHandle = (id: string) => {
    const found = runtime.getClient(id);
    if (!found) {
      throw new Error(`Missing test runtime: ${id}`);
    }
    return found;
  };
  const runtime = {
    getClient: vi.fn((id: string) => handles.get(id)),
    getPendingClient: vi.fn(() => undefined as Promise<typeof handle> | undefined),
    isStopInProgress: vi.fn(() => false),
    setSessionModel: vi.fn(async (id: string, model: string) =>
      controller.setSessionModel(requireHandle(id), model, id)
    ),
    setSessionMode: vi.fn(async (id: string, mode: string) =>
      controller.setSessionMode(requireHandle(id), mode, id)
    ),
    setConfigOption: vi.fn(async (sessionId: string, id: string, value: string) =>
      controller.setConfigOption(requireHandle(sessionId), id, value, sessionId)
    ),
  };
  const events: { type: string; configOptions?: SessionConfigOption[]; capabilities?: unknown }[] =
    [];
  const domain = {
    emitDelta: vi.fn((_id: string, event: (typeof events)[number]) =>
      events.push(structuredClone(event))
    ),
  };
  const service = new SessionConfigService({
    repository,
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: {
      getModels: async () => [
        {
          id: 'second',
          displayName: 'Second',
          description: '',
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          isDefault: true,
          supportedReasoningEfforts: [],
        },
      ],
    },
    sessionDomainService: unsafeCoerce(domain),
  });
  return {
    service,
    repository,
    runtime,
    handle,
    controller,
    connection,
    events,
    hooks,
    accessor,
    casModels,
    row: (id = 'session') => structuredClone(readRow(id)),
    installIdentity: () => {
      row = { ...row, providerSessionId: 'thread' };
    },
    addSession: (id: string) => {
      const other = createTestProcessHandle({
        providerSessionId: `thread-${id}`,
        connection: unsafeCoerce({
          setSessionConfigOption: async ({
            configId,
            value,
          }: {
            configId: string;
            value: string;
          }) => ({
            configOptions: other.configOptions.map((option) =>
              option.id === configId ? { ...option, currentValue: value } : option
            ),
          }),
        }),
      });
      other.configOptions = configOptions('first');
      handles.set(id, other);
      otherRows.set(id, {
        ...structuredClone(row),
        id,
        providerSessionId: other.providerSessionId,
      });
      return other;
    },
    statusWrite: () => {
      row = { ...row, status: 'RUNNING', updatedAt: new Date(row.updatedAt.getTime() + 1) };
    },
    clearSnapshot: () => {
      row = { ...row, providerMetadata: null, providerSessionId: null };
    },
    native: (model: string) =>
      service.applyConfigOptionsUpdateDelta('session', handle, configOptions(model)),
    models: () =>
      events.flatMap((event) =>
        event.type === 'config_options_update'
          ? [event.configOptions?.find((option) => option.id === 'model')?.currentValue]
          : []
      ),
  };
}
