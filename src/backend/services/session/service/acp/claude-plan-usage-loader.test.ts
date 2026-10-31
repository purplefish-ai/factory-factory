import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchClaudePlanUsage } from './claude-plan-usage-loader';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  initialize: vi.fn(),
  usage: vi.fn(),
  close: vi.fn(),
  spawn: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('@/backend/lib/node-runtime', () => ({ getNodeExecPath: () => '/electron/node' }));
vi.mock('./acp-runtime-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acp-runtime-spawn')>()),
  terminateCatalogProcess: mocks.terminate,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue({});
  mocks.usage.mockResolvedValue({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 28, resets_at: null },
      seven_day: { utilization: 42, resets_at: null },
    },
  });
  mocks.query.mockReturnValue({
    initializationResult: mocks.initialize,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: mocks.usage,
    close: mocks.close,
  });
});
afterEach(() => vi.useRealTimers());

describe('fetchClaudePlanUsage', () => {
  it('reads native quota without sending a model message or persisting a session', async () => {
    const result = await fetchClaudePlanUsage();
    expect(result).toMatchObject({
      status: 'available',
      windows: [
        { id: 'five_hour', usedPercent: 28 },
        { id: 'seven_day', usedPercent: 42 },
      ],
    });
    expect(mocks.usage).toHaveBeenCalledWith({ skipBehaviors: true });
    const invocation = mocks.query.mock.calls[0]?.[0];
    expect(invocation.options).toMatchObject({
      persistSession: false,
      tools: [],
      strictMcpConfig: true,
      settingSources: ['user'],
    });
    expect(await invocation.prompt[Symbol.asyncIterator]().next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(invocation.options.abortController.signal.aborted).toBe(true);
  });

  it('terminates its ephemeral query when the experimental response is incompatible', async () => {
    mocks.usage.mockResolvedValue({ unexpected: true });
    await expect(fetchClaudePlanUsage()).rejects.toThrow();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('uses the Electron-aware launcher and terminates the spawned usage process', async () => {
    const child = {};
    mocks.spawn.mockReturnValue(child);
    mocks.query.mockImplementation(({ options }) => {
      expect(options.spawnClaudeCodeProcess).toBeTypeOf('function');
      options.spawnClaudeCodeProcess({
        command: 'node',
        args: ['/app.asar/claude.js'],
        cwd: '/disposable',
        env: options.env,
        signal: options.abortController.signal,
      });
      return {
        initializationResult: mocks.initialize,
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: mocks.usage,
        close: mocks.close,
      };
    });

    await fetchClaudePlanUsage();

    expect(mocks.spawn).toHaveBeenCalledWith('/electron/node', ['/app.asar.unpacked/claude.js'], {
      cwd: '/disposable',
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
      signal: expect.any(AbortSignal),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(mocks.terminate).toHaveBeenCalledWith(child);
  });

  it('bounds a stalled native quota read and closes it', async () => {
    vi.useFakeTimers();
    mocks.usage.mockReturnValue(
      new Promise(() => {
        /* Simulate an unresponsive native control request. */
      })
    );
    const result = fetchClaudePlanUsage();
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15_001);
    await rejection;
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
