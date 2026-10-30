import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { AcpClientCallbacks } from './acp-connection';
import { createMockChildProcess, exitChildAfterSigterm } from './acp-runtime-manager.test-helpers';
import {
  fetchSessionLaunchOptionsFromAcp,
  launchOptionsFromConfig,
} from './session-launch-options-probe';
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
    const result = await fetchSessionLaunchOptionsFromAcp({ provider: 'CLAUDE', model: 'opus' });
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
