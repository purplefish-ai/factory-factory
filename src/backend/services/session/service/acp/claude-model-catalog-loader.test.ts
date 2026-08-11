import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { fetchClaudeModelCatalogFromAcp } from './claude-model-catalog-loader';

const mocks = vi.hoisted(() => ({
  closeSession: vi.fn(),
  connectionConstructor: vi.fn(),
  directAgentConstructor: vi.fn(),
  dispose: vi.fn(),
  extMethod: vi.fn(),
  getCurrentProcessEnv: vi.fn(),
  initialize: vi.fn(),
  ndJsonStream: vi.fn(),
  newSession: vi.fn(),
  prompt: vi.fn(),
  resolveAcpBinary: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('@agentclientprotocol/claude-agent-acp', () => ({
  ClaudeAcpAgent: class {
    constructor() {
      mocks.directAgentConstructor();
    }

    initialize = mocks.initialize;
    newSession = mocks.newSession;
    closeSession = mocks.closeSession;
    dispose = mocks.dispose;
  },
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentclientprotocol/sdk')>()),
  ClientSideConnection: class {
    constructor(...args: unknown[]) {
      mocks.connectionConstructor(...args);
    }

    initialize = mocks.initialize;
    newSession = mocks.newSession;
    closeSession = mocks.closeSession;
    extMethod = mocks.extMethod;
    prompt = mocks.prompt;
  },
  ndJsonStream: mocks.ndJsonStream,
}));

vi.mock('@/backend/services/logger.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/backend/services/logger.service')>()),
  getCurrentProcessEnv: mocks.getCurrentProcessEnv,
}));

vi.mock('./acp-runtime-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./acp-runtime-spawn')>()),
  resolveAcpBinary: mocks.resolveAcpBinary,
}));

const catalogSession = {
  sessionId: 'catalog-session',
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      category: 'model',
      currentValue: 'default',
      options: [
        {
          value: 'default',
          name: 'Default (recommended)',
          description: 'Opus 4.8 with 1M context · Best for everyday tasks',
        },
        {
          value: 'claude-fable-5[1m]',
          name: 'Fable',
          description: 'Fable 5 · Most capable for hard tasks',
        },
        {
          value: 'sonnet',
          name: 'Sonnet',
          description: 'Sonnet 5 · Efficient for routine tasks',
        },
      ],
    },
  ],
};

describe('fetchClaudeModelCatalogFromAcp', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.initialize.mockResolvedValue({});
    mocks.newSession.mockResolvedValue(catalogSession);
    mocks.closeSession.mockResolvedValue({});
    mocks.dispose.mockResolvedValue(undefined);
    mocks.extMethod.mockResolvedValue({});
    mocks.getCurrentProcessEnv.mockReturnValue({ FACTORY_SESSION_ENV: 'preserved' });
    mocks.ndJsonStream.mockReturnValue({ readable: {}, writable: {} });
    mocks.resolveAcpBinary.mockReturnValue('/resolved/claude-agent-acp');

    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: vi.fn((signal: NodeJS.Signals) => {
        child.killed = true;
        queueMicrotask(() => {
          child.signalCode = signal;
          child.emit('exit', null, signal);
        });
        return true;
      }),
    });
    mocks.spawn.mockReturnValue(unsafeCoerce(child));
  });

  it('uses the managed-policy-aware ACP executable for an ephemeral catalog session', async () => {
    expect(await fetchClaudeModelCatalogFromAcp()).toEqual([
      {
        id: 'default',
        displayName: 'Default — Opus 4.8 (1M)',
        description: 'Opus 4.8 with 1M context · Best for everyday tasks',
      },
      {
        id: 'claude-fable-5[1m]',
        displayName: 'Fable 5',
        description: 'Fable 5 · Most capable for hard tasks',
      },
      {
        id: 'sonnet',
        displayName: 'Sonnet 5',
        description: 'Sonnet 5 · Efficient for routine tasks',
      },
    ]);
    expect(mocks.directAgentConstructor).not.toHaveBeenCalled();
    expect(mocks.resolveAcpBinary).toHaveBeenCalledWith(
      '@agentclientprotocol/claude-agent-acp',
      'claude-agent-acp'
    );
    expect(mocks.spawn).toHaveBeenCalledWith('/resolved/claude-agent-acp', [], {
      cwd: tmpdir(),
      detached: false,
      env: {
        BROWSER: 'none',
        FACTORY_SESSION_ENV: 'preserved',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(mocks.initialize).toHaveBeenCalledWith({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'factory-factory',
        title: 'Factory Factory',
        version: '1.2.0',
      },
    });
    expect(mocks.newSession).toHaveBeenCalledWith({
      cwd: tmpdir(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            persistSession: false,
            settingSources: ['user'],
            strictMcpConfig: true,
            tools: [],
          },
        },
      },
    });
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.extMethod).toHaveBeenCalledWith('session/close', {
      sessionId: 'catalog-session',
    });
    expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('flattens grouped model options identified by a category-less model id', async () => {
    mocks.newSession.mockResolvedValue({
      sessionId: 'catalog-session',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'sonnet',
          options: [
            {
              group: 'latest',
              name: 'Latest models',
              options: [
                {
                  value: 'sonnet',
                  name: 'Sonnet',
                  description: 'Sonnet 5 · Efficient for routine tasks',
                },
              ],
            },
          ],
        },
      ],
    });

    await expect(fetchClaudeModelCatalogFromAcp()).resolves.toEqual([
      {
        id: 'sonnet',
        displayName: 'Sonnet 5',
        description: 'Sonnet 5 · Efficient for routine tasks',
      },
    ]);
  });

  it('keeps the error listener through SIGKILL escalation', async () => {
    vi.useFakeTimers();
    try {
      const catalogPromise = fetchClaudeModelCatalogFromAcp();
      const child = mocks.spawn.mock.results[0]?.value;
      const errorListenerCounts: number[] = [];
      child.kill.mockImplementation((_signal: NodeJS.Signals) => {
        child.killed = true;
        errorListenerCounts.push(child.listenerCount('error'));
        return true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mocks.spawn.mock.results[0]?.value.kill).not.toHaveBeenCalledWith('SIGKILL');

      await vi.advanceTimersByTimeAsync(5000);
      await expect(catalogPromise).resolves.toHaveLength(3);
      expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGKILL');
      expect(errorListenerCounts).toEqual([1, 1]);
      expect(mocks.spawn.mock.results[0]?.value.listenerCount('error')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes and terminates when the session has no model config option', async () => {
    mocks.newSession.mockResolvedValue({
      sessionId: 'catalog-session',
      configOptions: [],
    });

    await expect(fetchClaudeModelCatalogFromAcp()).rejects.toThrow(
      'Claude ACP session did not provide model options'
    );
    expect(mocks.extMethod).toHaveBeenCalledWith('session/close', {
      sessionId: 'catalog-session',
    });
    expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('terminates without closing when initialization fails', async () => {
    mocks.initialize.mockRejectedValue(new Error('initialization failed'));

    await expect(fetchClaudeModelCatalogFromAcp()).rejects.toThrow('initialization failed');
    expect(mocks.extMethod).not.toHaveBeenCalled();
    expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('terminates without closing when newSession fails before returning an ID', async () => {
    mocks.newSession.mockRejectedValue(new Error('new session failed'));

    await expect(fetchClaudeModelCatalogFromAcp()).rejects.toThrow('new session failed');
    expect(mocks.extMethod).not.toHaveBeenCalled();
    expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('terminates and preserves the catalog when closing the session fails', async () => {
    mocks.extMethod.mockRejectedValue(new Error('close failed'));

    await expect(fetchClaudeModelCatalogFromAcp()).resolves.toHaveLength(3);
    expect(mocks.spawn.mock.results[0]?.value.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
