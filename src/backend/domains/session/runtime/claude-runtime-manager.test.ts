import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeClientOptions,
  ClaudeClient as ClaudeClientType,
} from '@/backend/domains/session/claude/client';
import { ClaudeClient } from '@/backend/domains/session/claude/client';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { ClaudeRuntimeManager } from './claude-runtime-manager';

class MockClaudeClient extends EventEmitter {
  isRunning = vi.fn(() => true);
  stop = vi.fn(() => Promise.resolve());
  kill = vi.fn();
  getPid = vi.fn(() => 42);
}

describe('ClaudeRuntimeManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses pending creation to avoid duplicate clients', async () => {
    const manager = new ClaudeRuntimeManager();
    const options = { workingDir: '/tmp', sessionId: 's1' } as ClaudeClientOptions;
    const handlers = {};
    const context = { workspaceId: 'w1', workingDir: '/tmp' };

    const client = new MockClaudeClient();
    let resolveCreate: (value: ClaudeClientType) => void = () => undefined;
    let createCallCount = 0;

    const createSpy = vi.spyOn(ClaudeClient, 'create').mockImplementation(() => {
      createCallCount++;
      return new Promise<ClaudeClientType>((resolve) => {
        resolveCreate = resolve;
      });
    });

    const first = manager.getOrCreateClient('s1', options, handlers, context);
    const second = manager.getOrCreateClient('s1', options, handlers, context);

    await Promise.resolve();

    resolveCreate(unsafeCoerce<ClaudeClientType>(client));

    const [client1, client2] = await Promise.all([first, second]);

    expect(createCallCount).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(client1).toBe(client);
    expect(client2).toBe(client);
  });

  it('invokes session_id handler and skips exit handler when stopping', async () => {
    const manager = new ClaudeRuntimeManager();
    const options = { workingDir: '/tmp', sessionId: 's1' } as ClaudeClientOptions;
    const context = { workspaceId: 'w1', workingDir: '/tmp' };
    const client = new MockClaudeClient();

    vi.spyOn(ClaudeClient, 'create').mockResolvedValue(unsafeCoerce<ClaudeClientType>(client));

    const onSessionId = vi.fn().mockResolvedValue(undefined);
    const onExit = vi.fn().mockResolvedValue(undefined);

    await manager.createClient('s1', options, { onSessionId, onExit }, context);

    client.emit('session_id', 'claude-123');

    expect(onSessionId).toHaveBeenCalledWith('s1', 'claude-123');

    client.stop = vi.fn().mockImplementation(() => {
      client.emit('exit');
      return Promise.resolve();
    });

    await manager.stopClient('s1');

    expect(onExit).not.toHaveBeenCalled();
  });

  it('preserves lock during concurrent operations even if client exits', async () => {
    const manager = new ClaudeRuntimeManager();
    const options = { workingDir: '/tmp', sessionId: 's1' } as ClaudeClientOptions;
    const handlers = {};
    const context = { workspaceId: 'w1', workingDir: '/tmp' };

    const client1 = new MockClaudeClient();
    let createCallCount = 0;
    let resolveCreate: (value: ClaudeClientType) => void = () => undefined;

    vi.spyOn(ClaudeClient, 'create').mockImplementation(() => {
      createCallCount++;
      return new Promise<ClaudeClientType>((resolve) => {
        resolveCreate = resolve;
      });
    });

    const firstCall = manager.getOrCreateClient('s1', options, handlers, context);
    const secondCall = manager.getOrCreateClient('s1', options, handlers, context);

    await Promise.resolve();

    resolveCreate(unsafeCoerce<ClaudeClientType>(client1));
    const firstClient = await firstCall;
    expect(firstClient).toBe(client1);

    client1.emit('exit', { code: 0 });
    await Promise.resolve();

    const secondClient = await secondCall;
    expect(secondClient).toBe(client1);

    expect(createCallCount).toBe(1);
  });

  it('clears both creationLocks and lockRefCounts in stopAllClients', async () => {
    const manager = new ClaudeRuntimeManager();
    const options = { workingDir: '/tmp', sessionId: 's1' } as ClaudeClientOptions;
    const handlers = {};
    const context = { workspaceId: 'w1', workingDir: '/tmp' };

    const client = new MockClaudeClient();
    vi.spyOn(ClaudeClient, 'create').mockResolvedValue(unsafeCoerce<ClaudeClientType>(client));

    await manager.getOrCreateClient('s1', options, handlers, context);

    expect(manager.getClient('s1')).toBeDefined();

    await manager.stopAllClients();

    expect(manager.getClient('s1')).toBeUndefined();

    const client2 = new MockClaudeClient();
    vi.spyOn(ClaudeClient, 'create').mockResolvedValue(unsafeCoerce<ClaudeClientType>(client2));

    const newClient = await manager.getOrCreateClient('s1', options, handlers, context);
    expect(newClient).toBe(client2);
  });

  it('properly awaits pending creation to prevent premature ref count cleanup', async () => {
    const manager = new ClaudeRuntimeManager();
    const options = { workingDir: '/tmp', sessionId: 's1' } as ClaudeClientOptions;
    const handlers = {};
    const context = { workspaceId: 'w1', workingDir: '/tmp' };

    const client = new MockClaudeClient();
    let resolveCreate: (value: ClaudeClientType) => void = () => undefined;
    let createCallCount = 0;

    vi.spyOn(ClaudeClient, 'create').mockImplementation(() => {
      createCallCount++;
      return new Promise<ClaudeClientType>((resolve) => {
        resolveCreate = resolve;
      });
    });

    const firstCall = manager.getOrCreateClient('s1', options, handlers, context);

    await Promise.resolve();

    const secondCall = manager.getOrCreateClient('s1', options, handlers, context);
    const thirdCall = manager.getOrCreateClient('s1', options, handlers, context);

    await Promise.resolve();

    resolveCreate(unsafeCoerce<ClaudeClientType>(client));

    const [first, second, third] = await Promise.all([firstCall, secondCall, thirdCall]);

    expect(first).toBe(client);
    expect(second).toBe(client);
    expect(third).toBe(client);
    expect(createCallCount).toBe(1);
  });
});
