import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { ClaudeClientOptions, ClaudeClient as ClaudeClientType } from '../claude/index';
import { ClaudeClient } from '../claude/index';
import { SessionProcessManager } from './session.process-manager';

class MockClaudeClient extends EventEmitter {
  isRunning = vi.fn(() => true);
  stop = vi.fn(() => Promise.resolve());
  kill = vi.fn();
  getPid = vi.fn(() => 42);
}

describe('SessionProcessManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses pending creation to avoid duplicate clients', async () => {
    const manager = new SessionProcessManager();
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

    // Start two concurrent creation requests
    const first = manager.getOrCreateClient('s1', options, handlers, context);
    const second = manager.getOrCreateClient('s1', options, handlers, context);

    // Wait for at least one microtask to ensure mutex has processed
    await Promise.resolve();

    // Both calls should eventually resolve to the same client
    resolveCreate(unsafeCoerce<ClaudeClientType>(client));

    const [client1, client2] = await Promise.all([first, second]);

    // Should only have called create once due to mutex
    expect(createCallCount).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(client1).toBe(client);
    expect(client2).toBe(client);
  });

  it('invokes session_id handler and skips exit handler when stopping', async () => {
    const manager = new SessionProcessManager();
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
    const manager = new SessionProcessManager();
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

    // Start two concurrent creations
    const firstCall = manager.getOrCreateClient('s1', options, handlers, context);
    const secondCall = manager.getOrCreateClient('s1', options, handlers, context);

    // Wait for first to start
    await Promise.resolve();

    // Resolve and get first client
    resolveCreate(unsafeCoerce<ClaudeClientType>(client1));
    const firstClient = await firstCall;
    expect(firstClient).toBe(client1);

    // Simulate exit event
    client1.emit('exit', { code: 0 });
    await Promise.resolve();

    // Second call should still get the same client (was queued before exit)
    const secondClient = await secondCall;
    expect(secondClient).toBe(client1);

    // Only one create should have been called due to lock
    expect(createCallCount).toBe(1);
  });

  it('clears both creationLocks and lockRefCounts in stopAllClients', async () => {
    const manager = new SessionProcessManager();
    const options = { workingDir: '/tmp', sessionId: 's1' } as ClaudeClientOptions;
    const handlers = {};
    const context = { workspaceId: 'w1', workingDir: '/tmp' };

    const client = new MockClaudeClient();
    vi.spyOn(ClaudeClient, 'create').mockResolvedValue(unsafeCoerce<ClaudeClientType>(client));

    // Create a client through normal flow
    await manager.getOrCreateClient('s1', options, handlers, context);

    // Verify client exists
    expect(manager.getClient('s1')).toBeDefined();

    // Stop all clients
    await manager.stopAllClients();

    // Verify everything is cleaned up
    expect(manager.getClient('s1')).toBeUndefined();

    // Try creating a new client with the same sessionId
    // This should work without issues from stale ref counts
    const client2 = new MockClaudeClient();
    vi.spyOn(ClaudeClient, 'create').mockResolvedValue(unsafeCoerce<ClaudeClientType>(client2));

    const newClient = await manager.getOrCreateClient('s1', options, handlers, context);
    expect(newClient).toBe(client2);
  });
});
