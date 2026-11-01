import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  PromptRequest,
  PromptResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk/unstable';
import { vi } from 'vitest';
import type { AcpClientOptions, AcpProcessHandle } from '@/backend/services/session';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { deferred } from './event-delivery.test-support';

/** Replaces only process creation/transport. Never owns or signals a host PID/group. */
export function fakeEventProvider(
  Handle: typeof AcpProcessHandle,
  options: AcpClientOptions,
  beforePrompt: () => Promise<void> = async () => undefined,
  tracker?: ConstructorParameters<typeof AcpProcessHandle>[0]['nativeSessionTracker']
) {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn((_signal?: string) => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      return true;
    }),
  });
  const response = deferred<PromptResponse>();
  const called = deferred<void>();
  const connection = {
    prompt: vi.fn(async (_input: PromptRequest) => {
      await beforePrompt();
      called.resolve();
      return response.promise;
    }),
    cancel: vi.fn(async () => undefined),
    setSessionConfigOption: vi.fn(
      async ({ configId, value }: { configId: string; value: string }) => ({
        configOptions: handle.configOptions.map((entry) =>
          entry.id === configId ? { ...entry, currentValue: value } : entry
        ),
      })
    ),
    setSessionMode: vi.fn(async () => ({})),
    close: vi.fn(async () => undefined),
  };
  const handle = new Handle({
    provider: options.provider,
    providerSessionId: `native-${options.sessionId}`,
    child: unsafeCoerce<ChildProcess>(child),
    connection: unsafeCoerce<ConstructorParameters<typeof Handle>[0]['connection']>(connection),
    agentCapabilities: {},
    nativeSessionTracker: tracker,
  });
  tracker?.setRootSessionId(handle.acpSessionId);
  const choices = (id: string, category: string, values: string[]): SessionConfigOption => ({
    id,
    name: id,
    category,
    type: 'select',
    currentValue: values[0] ?? 'invalid-fixture-option',
    options: values.map((value) => ({ value, name: value })),
  });
  handle.configOptions = [
    choices('model', 'model', ['old-model', 'sonnet', 'gpt-5.4']),
    choices(
      'mode',
      'mode',
      options.provider === 'CLAUDE'
        ? ['default', 'bypassPermissions', 'plan']
        : ['read-only', 'workspace-write', 'agent-full-access']
    ),
    choices('reasoning_effort', 'thought_level', ['low', 'high']),
    choices('collaboration_mode', 'collaboration_mode', ['default', 'plan']),
  ];
  return {
    handle,
    child,
    connection,
    called: called.promise,
    response,
    options,
    update: (update: Record<string, unknown>) =>
      tracker?.onRawMessage({
        method: 'session/update',
        params: { sessionId: handle.acpSessionId, update },
      }),
  };
}
