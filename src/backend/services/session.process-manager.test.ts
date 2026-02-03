import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    const createPromise = new Promise<ClaudeClientType>((resolve) => {
      resolveCreate = resolve;
    });

    const createSpy = vi
      .spyOn(ClaudeClient, 'create')
      .mockImplementation(async () => createPromise);

    const first = manager.getOrCreateClient('s1', options, handlers, context);
    const second = manager.getOrCreateClient('s1', options, handlers, context);

    expect(createSpy).toHaveBeenCalledTimes(1);

    resolveCreate(client as unknown as ClaudeClientType);

    const [client1, client2] = await Promise.all([first, second]);
    expect(client1).toBe(client);
    expect(client2).toBe(client);
  });

  it('invokes session_id handler and skips exit handler when stopping', async () => {
    const manager = new SessionProcessManager();
    const options = { workingDir: '/tmp', sessionId: 's1' } as ClaudeClientOptions;
    const context = { workspaceId: 'w1', workingDir: '/tmp' };
    const client = new MockClaudeClient();

    vi.spyOn(ClaudeClient, 'create').mockResolvedValue(client as unknown as ClaudeClientType);

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
});
