import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@/test-utils/deferred';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { AcpClientCallbacks } from './acp-connection';
import {
  createMockChildProcess as createChild,
  exitChildAfterSigterm,
} from './acp-runtime-manager.test-helpers';
import {
  fetchSessionLaunchOptionsFromAcp as startProbe,
  launchOptionsFromConfig,
} from './session-launch-options-probe';
function fetchSessionLaunchOptionsFromAcp(input: Parameters<typeof startProbe>[0]) {
  return startProbe(input).result;
}
function createMockChildProcess() {
  const child = createChild();
  child.once('exit', () => {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.destroy();
    }
    queueMicrotask(() => child.emit('close', child.exitCode, child.signalCode));
  });
  return child;
}
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  initialize: vi.fn(),
  newSession: vi.fn(),
  set: vi.fn(),
  ext: vi.fn(),
  close: vi.fn(),
  prompt: vi.fn(),
  callbacks: undefined as AcpClientCallbacks | undefined,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@agentclientprotocol/sdk/unstable', () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(() => ({ readable: {}, writable: {} })),
}));
vi.mock('./acp-connection', () => ({
  createAcpConnection: (callbacks: AcpClientCallbacks) => {
    mocks.callbacks = callbacks;
    return {
      initialize: mocks.initialize,
      newSession: mocks.newSession,
      setSessionConfigOption: mocks.set,
      extMethod: mocks.ext,
      close: mocks.close,
      closed: Promise.resolve(),
      prompt: mocks.prompt,
    };
  },
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  getCurrentProcessEnv: () => ({}),
}));
function config(model = 'sonnet'): SessionConfigOption[] {
  return [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: ['sonnet', 'opus'].map((value) => ({ value, name: value })),
    },
    {
      id: 'mode',
      category: 'mode',
      name: 'Access',
      type: 'select',
      currentValue: 'default',
      options: ['default', 'plan'].map((value) => ({ value, name: value })),
    },
    {
      id: 'effort',
      category: 'thought_level',
      name: 'Effort',
      type: 'select',
      currentValue: 'default',
      options: ['default', 'low', 'xhigh', 'max'].map((value) => ({ value, name: value })),
    },
  ];
}
describe('native launch capability discovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.initialize.mockResolvedValue({});
    mocks.newSession.mockResolvedValue({ sessionId: 'probe', configOptions: config() });
    mocks.set.mockResolvedValue({ configOptions: config('opus') });
    mocks.ext.mockResolvedValue({});
  });
  it.each([
    { provider: 'CLAUDE' as const, effortId: 'thought_level', modeId: 'mode' },
    { provider: 'CODEX' as const, effortId: 'reasoning_effort', modeId: 'collaboration_mode' },
  ])('discovers ID-only $provider thinking and Plan controls', ({ provider, effortId, modeId }) => {
    const native = config().map((option) => {
      if (option.category === 'thought_level') {
        return { ...option, id: effortId, category: undefined };
      }
      if (option.category === 'mode' && option.type === 'select') {
        return { ...option, id: modeId, category: undefined, currentValue: 'plan' };
      }
      return option;
    });
    expect(launchOptionsFromConfig(provider, native)).toMatchObject({
      reasoning: {
        options: expect.arrayContaining([{ value: 'max', label: 'max' }]),
        selected: 'default',
        defaultValue: 'default',
      },
      planMode: { supported: true, selected: true },
    });
  });
  it('uses the caller-resolved Codex environment without resolving account services in ACP', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    await fetchSessionLaunchOptionsFromAcp({
      provider: 'CODEX',
      env: { CODEX_HOME: '/chosen/profile', ACCOUNT_CONTEXT_ONLY: 'yes' },
    });
    expect(mocks.spawn.mock.calls[0]?.[2].env).toMatchObject({
      CODEX_HOME: '/chosen/profile',
      ACCOUNT_CONTEXT_ONLY: 'yes',
    });
  });
  it('selects the requested Claude model and exposes native extended effort levels without a prompt', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    const probe = startProbe({ provider: 'CLAUDE', model: 'opus' });
    const result = await probe.result;
    // The requested model is reported before the disposable session is torn down.
    await probe.drained;
    expect(result.model).toBe('opus');
    expect(result.reasoning.options.map((option) => option.value)).toEqual([
      'default',
      'low',
      'xhigh',
      'max',
    ]);
    expect(result.reasoning.defaultValue).toBe('default');
    expect(result.planMode).toEqual({ supported: true, selected: false });
    expect(result.accessMode).toEqual({
      options: [{ value: 'default', label: 'default' }],
      selected: 'default',
    });
    expect(mocks.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: {
          claudeCode: {
            options: {
              tools: [],
              persistSession: false,
              settingSources: ['user'],
              strictMcpConfig: true,
            },
          },
        },
      })
    );
    expect(mocks.set).toHaveBeenCalledWith({
      sessionId: 'probe',
      configId: 'model',
      value: 'opus',
    });
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.ext).toHaveBeenCalledWith('session/close', { sessionId: 'probe' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('captures other selected models in the same session after reporting the requested one', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    mocks.set.mockImplementation(({ value }: { value: string }) =>
      Promise.resolve({ configOptions: config(value) })
    );
    const selectAdditionalModels = vi.fn((models: readonly string[]) => models);
    const probe = startProbe({ provider: 'CLAUDE', model: 'opus', selectAdditionalModels });
    expect((await probe.result).model).toBe('opus');
    const additional = await probe.additional;
    await probe.drained;
    expect(selectAdditionalModels).toHaveBeenCalledExactlyOnceWith(['sonnet']);
    expect(additional).toEqual([
      expect.objectContaining({
        model: 'sonnet',
        // A model switch may carry the previous level forward, so no default is claimed.
        reasoning: { options: expect.arrayContaining([{ value: 'max', label: 'max' }]) },
      }),
    ]);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.newSession).toHaveBeenCalledOnce();
    expect(mocks.set.mock.calls.map(([request]) => request.value)).toEqual(['opus', 'sonnet']);
    expect(mocks.ext).toHaveBeenCalledWith('session/close', { sessionId: 'probe' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('captures no other models without a selector', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    const probe = startProbe({ provider: 'CLAUDE', model: 'opus' });
    await probe.result;
    expect(await probe.additional).toEqual([]);
    expect(mocks.set).toHaveBeenCalledOnce();
  });
  it('reports the requested model before a stalled sweep and keeps what the sweep captured', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
      mocks.spawn.mockReturnValue(child);
      const advertised = (model?: string) =>
        config(model).map((option) =>
          option.id === 'model' && option.type === 'select'
            ? {
                ...option,
                options: ['sonnet', 'opus', 'haiku', 'fable'].map((value) => ({
                  value,
                  name: value,
                })),
              }
            : option
        );
      mocks.newSession.mockResolvedValue({ sessionId: 'probe', configOptions: advertised() });
      mocks.set
        .mockResolvedValueOnce({ configOptions: advertised('opus') })
        .mockResolvedValueOnce({ configOptions: advertised('sonnet') })
        .mockReturnValueOnce(new Promise(() => undefined));
      const probe = startProbe({
        provider: 'CLAUDE',
        model: 'opus',
        selectAdditionalModels: (models) => models,
      });
      expect((await probe.result).model).toBe('opus');
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await probe.additional).map((options) => options.model)).toEqual(['sonnet']);
      // The stalled switch ends the sweep: the last model is never attempted.
      expect(mocks.set).toHaveBeenCalledTimes(3);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('bounds the whole sweep by one budget and keeps the models captured in time', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
      mocks.spawn.mockReturnValue(child);
      const many = Array.from({ length: 10 }, (_, i) => `m${i}`);
      const advertised = (model = 'm0') =>
        config(model).map((option) =>
          option.id === 'model' && option.type === 'select'
            ? { ...option, options: many.map((value) => ({ value, name: value })) }
            : option
        );
      mocks.newSession.mockResolvedValue({ sessionId: 'probe', configOptions: advertised() });
      // Every switch answers just inside its own 30s bound.
      mocks.set.mockImplementation(
        ({ value }: { value: string }) =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ configOptions: advertised(value) }), 25_000);
          })
      );
      const probe = startProbe({
        provider: 'CLAUDE',
        model: 'm0',
        selectAdditionalModels: (models) => models,
      });
      await vi.advanceTimersByTimeAsync(0);
      await probe.result;
      await vi.advanceTimersByTimeAsync(10 * 30_000);
      // Two switches fit in the 60s budget; the third is cut off at the deadline.
      expect((await probe.additional).map((options) => options.model)).toEqual(['m1', 'm2']);
      await probe.drained;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('waits longer for provider session creation than for other discovery steps', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
      mocks.spawn.mockReturnValue(child);
      const creating = deferred<{ sessionId: string; configOptions: SessionConfigOption[] }>();
      mocks.newSession.mockReturnValueOnce(creating.promise);
      let settled = false;
      const probe = startProbe({ provider: 'CLAUDE', model: 'opus' });
      const probing = probe.result.finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      creating.resolve({ sessionId: 'probe', configOptions: config() });
      expect((await probing).model).toBe('opus');
      await probe.drained;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('preserves the shutdown reason when Node emits AbortError after spawn', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    const initializing = deferred<void>();
    mocks.initialize.mockReturnValue(initializing.promise);
    const cancellation = new AbortController();
    const reason = new Error('Launch discovery stopped');
    const probe = startProbe({ provider: 'CLAUDE', signal: cancellation.signal });
    const rejected = expect(probe.result).rejects.toBe(reason);
    cancellation.abort(reason);
    child.emit(
      'error',
      Object.assign(new Error('The operation was aborted', { cause: reason }), {
        name: 'AbortError',
      })
    );
    try {
      await rejected;
      await probe.drained;
    } finally {
      initializing.resolve();
    }
  });

  it('passes cancellation to the disposable child and rejects pre-aborted probes', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    const cancellation = new AbortController();
    await fetchSessionLaunchOptionsFromAcp({ provider: 'CLAUDE', signal: cancellation.signal });
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ signal: cancellation.signal })
    );
    mocks.spawn.mockClear();
    cancellation.abort(new Error('stopped'));
    await expect(
      fetchSessionLaunchOptionsFromAcp({ provider: 'CLAUDE', signal: cancellation.signal })
    ).rejects.toThrow('stopped');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects tool permissions and interactive elicitation during disposable discovery', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    await fetchSessionLaunchOptionsFromAcp({ provider: 'CLAUDE' });
    await expect(mocks.callbacks?.requestPermission(unsafeCoerce({}))).rejects.toThrow(
      'cannot service provider callbacks'
    );
    await expect(mocks.callbacks?.createElicitation?.(unsafeCoerce({}))).rejects.toThrow(
      'cannot service provider callbacks'
    );
  });

  it('keeps known unsupported thinking distinct from discovery failure', () => {
    expect(
      launchOptionsFromConfig(
        'CLAUDE',
        config().filter((option) => option.category !== 'thought_level')
      ).reasoning
    ).toEqual({ options: [] });
    const codex = config().map((option) =>
      option.id === 'mode' && option.type === 'select'
        ? {
            ...option,
            id: 'collaboration_mode',
            category: 'collaboration_mode',
            currentValue: 'plan',
          }
        : option
    );
    expect(launchOptionsFromConfig('CODEX', codex).planMode).toEqual({
      supported: true,
      selected: true,
    });
  });
  it('closes a created session and terminates after an unsupported model', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    await expect(
      fetchSessionLaunchOptionsFromAcp({ provider: 'CLAUDE', model: 'missing' })
    ).rejects.toThrow('Unsupported model');
    expect(mocks.ext).toHaveBeenCalledWith('session/close', { sessionId: 'probe' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('terminates after initialization failure without inventing session identity', async () => {
    const child = createMockChildProcess();
    exitChildAfterSigterm(child);
    mocks.spawn.mockReturnValue(child);
    mocks.initialize.mockRejectedValueOnce(new Error('Initialization failed'));
    await expect(fetchSessionLaunchOptionsFromAcp({ provider: 'CODEX' })).rejects.toThrow(
      'Initialization failed'
    );
    expect(mocks.newSession).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('bounds stalled model selection and closes its disposable process', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
      mocks.spawn.mockReturnValue(child);
      mocks.set.mockReturnValueOnce(
        new Promise(() => {
          /* Model configuration never responds. */
        })
      );
      const probing = fetchSessionLaunchOptionsFromAcp({ provider: 'CLAUDE', model: 'opus' }).catch(
        (error: unknown) => error
      );
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await probing).toMatchObject({ message: expect.stringContaining('timed out') });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds teardown close after stalled model selection instead of waiting another startup timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = createMockChildProcess();
      exitChildAfterSigterm(child);
      mocks.spawn.mockReturnValue(child);
      mocks.set.mockReturnValueOnce(new Promise(() => undefined));
      mocks.ext.mockReturnValueOnce(new Promise(() => undefined));
      let finished = false;
      const probing = fetchSessionLaunchOptionsFromAcp({ provider: 'CLAUDE', model: 'opus' }).catch(
        (error: unknown) => {
          finished = true;
          return error;
        }
      );
      await vi.advanceTimersByTimeAsync(30_001);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1001);
      expect(finished).toBe(true);
      expect(await probing).toMatchObject({ message: expect.stringContaining('timed out') });
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mocks.close).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
