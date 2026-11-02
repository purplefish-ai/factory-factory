import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateAgentExecution } from '@/backend/orchestration/agent-native-validation';
import * as acpModelSelection from '@/backend/services/session/service/acp/acp-model-selection';
import { createMockChildProcess } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { createSessionProviderResolverService } from '@/backend/services/session/service/data/session-provider-resolver.service';
import { fetchAccountSessionLaunchOptions } from './session-launch-options-provider';
import { SessionLaunchOptionsService } from './session-launch-options.service';
import { SessionConfigService } from './session.config.service';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), preview: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('@/backend/services/codex-accounts', () => ({
  codexAccountService: { getPreviewRuntimeContext: mocks.preview },
}));
vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  getCurrentProcessEnv: () => ({}),
}));

const requestSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

function config(model = 'initial') {
  return [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: [
        ...new Set([model, 'initial']),
        ...Array.from({ length: 40 }, (_, i) => `model-${i}`),
      ].map((value) => ({
        value,
        name: value,
      })),
    },
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      name: 'Effort',
      type: 'select',
      currentValue: 'low',
      options: ['low', 'high'].map((value) => ({ value, name: value })),
    },
    {
      id: 'mode',
      category: 'mode',
      name: 'Access',
      type: 'select',
      currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }],
    },
  ];
}

function fakeProvider(
  options: { stallSelection?: boolean; stallClose?: boolean; nativeModel?: string } = {}
) {
  const child = createMockChildProcess();
  child.kill = vi.fn(() => true);
  const requests: z.infer<typeof requestSchema>[] = [];
  const reply = (id: string | number | undefined, result: unknown) => {
    if (!child.stdout.destroyed) {
      return child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    }
    return false;
  };
  const respondToRequest = (request: z.infer<typeof requestSchema>) => {
    if (request.method === 'initialize') {
      reply(request.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    } else if (request.method === 'session/new') {
      reply(request.id, { sessionId: 'probe', configOptions: config(options.nativeModel) });
    } else if (request.method === 'session/set_config_option' && !options.stallSelection) {
      reply(request.id, { configOptions: config(z.string().parse(request.params?.value)) });
    } else if (request.method === 'session/close' && !options.stallClose) {
      reply(request.id, {});
    }
  };
  let buffered = '';
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => undefined);
  }
  child.stdin.on('data', (data: Buffer) => {
    buffered += data.toString();
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const request = requestSchema.parse(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
      requests.push(request);
      respondToRequest(request);
      newline = buffered.indexOf('\n');
    }
  });
  return {
    child,
    requests,
    reply,
    exit() {
      child.exitCode = 137;
      child.emit('exit', 137, 'SIGKILL');
    },
    async drain() {
      child.exitCode = 137;
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream.destroy();
      }
      await vi.advanceTimersByTimeAsync(1);
      child.emit('close', 137, 'SIGKILL');
      await vi.advanceTimersByTimeAsync(1);
    },
  };
}

describe('native launch admission through actual child drain', () => {
  let peers: ReturnType<typeof fakeProvider>[];
  let nextOptions: Parameters<typeof fakeProvider>[0];
  const getSettings = vi.fn();
  const request = (model: string, codexAccountId = 'account-a') => ({
    provider: 'CODEX' as const,
    model,
    codexAccountId,
  });
  const settled = <T>(promise: Promise<T>) => promise.catch((error: unknown) => error);
  const service = () =>
    new SessionLaunchOptionsService({
      fetchOptions: fetchAccountSessionLaunchOptions,
      getSettings,
      resolveAccountId: async (input) =>
        (
          await mocks.preview({
            accountId: input.codexAccountId,
            model: input.model,
          })
        ).accountId,
    });
  beforeEach(() => {
    vi.useFakeTimers();
    peers = [];
    nextOptions = { stallSelection: true, stallClose: true };
    getSettings.mockResolvedValue({});
    mocks.preview.mockImplementation(({ accountId }) =>
      Promise.resolve({
        accountId: accountId ?? 'account-a',
        env: { CODEX_HOME: `/fake/${accountId ?? 'account-a'}` },
      })
    );
    mocks.spawn.mockImplementation(() => {
      const peer = fakeProvider(nextOptions);
      peers.push(peer);
      return peer.child;
    });
  });
  afterEach(async () => {
    for (const peer of peers) {
      await peer.drain();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('confirms a Claude alias against the actual advertised canonical model for preview', async () => {
    nextOptions = { nativeModel: 'claude-sonnet-4-6' };
    const options = service();
    const sessionConfigService = new SessionConfigService({
      repository: {} as never,
      runtimeManager: {} as never,
      codexModelCatalogService: { getModels: vi.fn() },
      launchOptionsService: options,
    });
    const settings = {
      defaultClaudeModel: 'sonnet',
      defaultCodexModel: 'default',
      defaultClaudeReasoningEffort: null,
      defaultCodexReasoningEffort: null,
    };
    const ports = {
      sessionConfigService,
      userSettingsQueryService: { get: () => Promise.resolve(settings) },
      sessionProviderResolverService: createSessionProviderResolverService({
        getDefaultSessionProvider: () => Promise.resolve('CLAUDE'),
        getModelDefaults: () => Promise.resolve(settings),
        findWorkspace: () => Promise.resolve(null),
      }),
    };
    const preview = validateAgentExecution(
      { version: 1, provider: 'CLAUDE', model: 'sonnet' },
      ports
    );
    await vi.advanceTimersByTimeAsync(5001);
    expect(await preview).toMatchObject({
      status: 'VALIDATED',
      intent: { requestedModel: 'sonnet', model: 'claude-sonnet-4-6', reasoningEffort: 'low' },
    });
    expect(peers).toHaveLength(1);
    expect(peers[0]!.requests.some((request) => request.method === 'session/prompt')).toBe(false);
  });

  it('validates typed Codex default intent through the configured public service and actual SDK probe', async () => {
    nextOptions = { nativeModel: 'gpt-5.4' };
    let account = 'account-a';
    mocks.preview.mockImplementation(({ accountId }) =>
      Promise.resolve({
        accountId: accountId ?? account,
        env: { CODEX_HOME: `/fake/${accountId ?? account}` },
      })
    );
    const settings = {
      defaultClaudeModel: 'sonnet',
      defaultCodexModel: 'default',
      defaultClaudeReasoningEffort: null,
      defaultCodexReasoningEffort: 'xhigh',
    };
    getSettings.mockImplementation(async () => settings);
    const options = service();
    const sessionConfigService = new SessionConfigService({
      repository: {} as never,
      runtimeManager: {} as never,
      codexModelCatalogService: { getModels: vi.fn() },
      launchOptionsService: options,
    });
    const ports = {
      sessionConfigService,
      userSettingsQueryService: { get: async () => settings },
      sessionProviderResolverService: createSessionProviderResolverService({
        getDefaultSessionProvider: async () => 'CODEX',
        getModelDefaults: async () => settings,
        findWorkspace: async () => null,
      }),
    };
    const first = validateAgentExecution({ version: 1 }, ports);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await first).toMatchObject({
      status: 'VALIDATED',
      intent: {
        provider: 'CODEX',
        requestedModel: 'default',
        model: 'gpt-5.4',
        reasoningEffort: 'low',
        effortNormalization: 'INHERITED_TO_NATIVE_DEFAULT',
      },
    });
    settings.defaultCodexReasoningEffort = 'high';
    expect(await validateAgentExecution({ version: 1 }, ports)).toMatchObject({
      status: 'VALIDATED',
      intent: { reasoningEffort: 'high', effortNormalization: 'NONE' },
    });
    expect(peers).toHaveLength(1);
    expect(
      await validateAgentExecution(
        { version: 1, provider: 'CODEX', reasoningEffort: 'xhigh' },
        ports
      )
    ).toMatchObject({ status: 'UNSUPPORTED' });
    account = 'account-b';
    const otherAccount = validateAgentExecution({ version: 1 }, ports);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await otherAccount).toMatchObject({ status: 'VALIDATED' });
    expect(peers).toHaveLength(2);
    expect(mocks.spawn.mock.calls.map((args) => args[2].env.CODEX_HOME)).toEqual([
      '/fake/account-a',
      '/fake/account-b',
    ]);
    expect(peers.flatMap((peer) => peer.requests).some((r) => r.method === 'session/prompt')).toBe(
      false
    );
    expect(peers[0]!.requests.find((r) => r.method === 'session/new')?.params).toMatchObject({
      mcpServers: [],
    });
  });

  it('keeps eight timed-out native lifetimes charged through KILL and exit until child close', async () => {
    const options = service();
    const running = Array.from({ length: 8 }, (_, i) =>
      settled(options.getOptions(request(`model-${i}`)))
    );
    const coalesced = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(1);
    expect(peers).toHaveLength(8);
    expect(
      peers.every((peer) => peer.requests.some((r) => r.method === 'session/set_config_option'))
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(36_001);
    expect(await Promise.all(running)).toEqual(
      Array.from({ length: 8 }, () =>
        expect.objectContaining({
          message: expect.stringContaining('timed out'),
        })
      )
    );
    expect(await coalesced).toMatchObject({ message: expect.stringContaining('timed out') });
    expect(
      peers.every((peer) => peer.child.kill.mock.calls.some((args) => args[0] === 'SIGKILL'))
    ).toBe(true);
    expect(peers.every((peer) => peer.child.stdout.destroyed)).toBe(true);
    const ninth = settled(options.getOptions(request('model-8')));
    await vi.advanceTimersByTimeAsync(1);
    expect(peers).toHaveLength(8);
    expect(await ninth).toMatchObject({ message: expect.stringContaining('busy') });
    for (const peer of peers) {
      peer.exit();
    }
    const afterExit = settled(options.getOptions(request('model-8')));
    await vi.advanceTimersByTimeAsync(1);
    expect(peers).toHaveLength(8);
    expect(await afterExit).toMatchObject({ message: expect.stringContaining('busy') });
    expect(await settled(options.getOptions(request('model-0')))).toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    await peers[0]!.drain();
    const replacement = settled(options.getOptions(request('model-8')));
    await vi.advanceTimersByTimeAsync(1);
    expect(peers).toHaveLength(9);
    expect(await settled(options.getOptions(request('model-9')))).toMatchObject({
      message: expect.stringContaining('busy'),
    });
    await vi.advanceTimersByTimeAsync(36_001);
    expect(await replacement).toMatchObject({ message: expect.stringContaining('timed out') });
    expect(peers.flatMap((peer) => peer.requests).some((r) => r.method === 'session/prompt')).toBe(
      false
    );
  });

  it('expires a successful same-key result without releasing its still-live native charge', async () => {
    nextOptions = {};
    const options = service();
    const result = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toMatchObject({ model: 'model-0', reasoning: { selected: 'low' } });
    getSettings.mockResolvedValue({ defaultCodexReasoningEffort: 'high' });
    expect(await options.getOptions(request('model-0'))).toMatchObject({
      reasoning: { selected: 'high' },
    });
    await vi.advanceTimersByTimeAsync(30_001);
    const expired = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(1);
    expect(peers).toHaveLength(1);
    expect(await expired).toMatchObject({ message: expect.stringContaining('busy') });
    await peers[0]!.drain();
    const refreshed = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await refreshed).toMatchObject({ model: 'model-0' });
    expect(peers).toHaveLength(2);
  });

  it('shares a failed result after consuming a late native response during cleanup, then retries after drain', async () => {
    // Call through to actual model selection: its completion proves the real
    // SDK decoded and delivered the late response, beyond merely writing bytes.
    const modelSelection = vi.spyOn(acpModelSelection, 'applyAcpStartupModel');
    const options = service();
    const failed = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(30_001);
    const old = peers[0]!;
    const selection = old.requests.find((r) => r.method === 'session/set_config_option')!;
    expect(old.requests.some((r) => r.method === 'session/close')).toBe(true);
    expect(old.child.kill).not.toHaveBeenCalled();
    expect(old.child.stdout.destroyed).toBe(false);
    const nativeWork = modelSelection.mock.results[0];
    if (nativeWork?.type !== 'return') {
      throw new Error('Native model selection did not start');
    }
    let nativeResult: unknown;
    void nativeWork.value.then(
      (value) => {
        nativeResult = value;
      },
      (error: unknown) => {
        nativeResult = error;
      }
    );
    expect(old.reply(selection.id, { configOptions: config('model-0') })).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(nativeResult).toMatchObject([
      { id: 'model', currentValue: 'model-0' },
      { id: 'reasoning_effort' },
      { id: 'mode' },
    ]);
    expect(old.child.stdout.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(6001);
    expect(old.child.stdout.destroyed).toBe(true);
    expect(await failed).toMatchObject({ message: expect.stringContaining('timed out') });
    expect(await settled(options.getOptions(request('model-0')))).toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    expect(peers).toHaveLength(1);
    await old.drain();
    nextOptions = {};
    const retry = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await retry).toMatchObject({ model: 'model-0' });
    expect(peers).toHaveLength(2);
  });

  it('isolates effective accounts, models and providers and reapplies fresh defaults to cloned results', async () => {
    nextOptions = {};
    const options = service();
    const calls = [
      request('model-0'),
      request('model-0', 'account-b'),
      request('model-1'),
      { provider: 'CLAUDE' as const, model: 'model-0' },
      { provider: 'CODEX' as const, model: 'model-0' },
    ];
    const results = calls.map((input) => settled(options.getOptions(input)));
    await vi.advanceTimersByTimeAsync(5001);
    const values = await Promise.all(results);
    expect(values).toMatchObject([
      { provider: 'CODEX', model: 'model-0' },
      { provider: 'CODEX', model: 'model-0' },
      { provider: 'CODEX', model: 'model-1' },
      { provider: 'CLAUDE', model: 'model-0' },
      { provider: 'CODEX', model: 'model-0' },
    ]);
    expect(peers).toHaveLength(4);
    expect(mocks.spawn.mock.calls.map((args) => args[2].env.CODEX_HOME)).toEqual([
      undefined,
      '/fake/account-a',
      '/fake/account-b',
      '/fake/account-a',
    ]);
    const first = await options.getOptions(request('model-0'));
    first.reasoning.options.length = 0;
    getSettings.mockResolvedValue({ defaultCodexReasoningEffort: 'high' });
    expect(await options.getOptions(request('model-0'))).toMatchObject({
      reasoning: {
        selected: 'high',
        defaultValue: 'low',
        options: [{ value: 'low' }, { value: 'high' }],
      },
    });
    const session = peers.flatMap((peer) => peer.requests).find((r) => r.method === 'session/new');
    expect(session?.params).toMatchObject({
      mcpServers: [],
      _meta: {
        claudeCode: { options: { tools: [], persistSession: false, strictMcpConfig: true } },
      },
    });
    expect(peers.flatMap((peer) => peer.requests).some((r) => r.method === 'session/prompt')).toBe(
      false
    );
  });

  it('retains spawn-error admission until close and observes later child errors safely', async () => {
    const options = service();
    mocks.spawn.mockImplementationOnce(() => {
      const peer = fakeProvider({ stallSelection: true });
      peers.push(peer);
      queueMicrotask(() => peer.child.emit('error', new Error('ENOENT fake adapter')));
      return peer.child;
    });
    const failed = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await failed).toMatchObject({ message: expect.stringContaining('ENOENT fake adapter') });
    peers[0]!.child.emit('error', new Error('late child error'));
    expect(await settled(options.getOptions(request('model-0')))).toMatchObject({
      message: expect.stringContaining('ENOENT fake adapter'),
    });
    expect(peers).toHaveLength(1);
    await peers[0]!.drain();
    const retry = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(36_001);
    expect(peers).toHaveLength(2);
    expect(await retry).toMatchObject({ message: expect.stringContaining('timed out') });
  });

  it('releases a synchronous spawn failure and observes child close occurring inside cleanup', async () => {
    const options = service();
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error('sync spawn failed');
    });
    expect(await settled(options.getOptions(request('model-0')))).toMatchObject({
      message: 'sync spawn failed',
    });
    nextOptions = {};
    mocks.spawn.mockImplementationOnce(() => {
      const peer = fakeProvider();
      peers.push(peer);
      peer.child.kill.mockImplementation(() => {
        peer.exit();
        let remaining = 3;
        for (const stream of [peer.child.stdin, peer.child.stdout, peer.child.stderr]) {
          stream.once('close', () => {
            if (--remaining === 0) {
              peer.child.emit('close', 0, null);
            }
          });
          stream.destroy();
        }
        return true;
      });
      return peer.child;
    });
    const success = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(1);
    expect(await success).toMatchObject({ model: 'model-0' });
    await vi.advanceTimersByTimeAsync(30_001);
    const refreshed = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await refreshed).toMatchObject({ model: 'model-0' });
    expect(peers).toHaveLength(2);
  });

  it('joins child close that precedes session cleanup after a pending ACP operation', async () => {
    const options = service();
    const interrupted = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(1);
    const peer = peers[0]!;
    // End the physical child while selection is awaiting a response. Observe
    // close at the pipe boundary rather than attaching a listener in finally.
    peer.exit();
    let remaining = 3;
    for (const stream of [peer.child.stdin, peer.child.stdout, peer.child.stderr]) {
      stream.once('close', () => {
        if (--remaining === 0) {
          peer.child.emit('close', 137, 'SIGKILL');
        }
      });
      stream.destroy();
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(await interrupted).toBeInstanceOf(Error);
    nextOptions = {};
    const retry = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await retry).toMatchObject({ model: 'model-0' });
    expect(peers).toHaveLength(2);
  });

  it('does not spawn when effective-account preflight fails', async () => {
    const options = service();
    mocks.preview.mockRejectedValueOnce(new Error('account unavailable'));
    expect(await settled(options.getOptions(request('model-0')))).toMatchObject({
      message: 'account unavailable',
    });
    expect(peers).toHaveLength(0);
  });

  it('releases a wrapper preflight failure after admission without spawning native work', async () => {
    const options = service();
    mocks.preview
      .mockResolvedValueOnce({ accountId: 'account-a' })
      .mockRejectedValueOnce(new Error('account changed during preflight'));
    expect(await settled(options.getOptions(request('model-0')))).toMatchObject({
      message: 'account changed during preflight',
    });
    expect(peers).toHaveLength(0);
    nextOptions = {};
    const retry = settled(options.getOptions(request('model-0')));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await retry).toMatchObject({ model: 'model-0' });
    expect(peers).toHaveLength(1);
  });
});
