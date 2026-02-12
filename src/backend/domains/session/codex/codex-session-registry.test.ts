import { describe, expect, it, vi } from 'vitest';
import { CodexSessionRegistry, InMemoryCodexThreadMappingStore } from './codex-session-registry';
import type { CodexThreadMappingStore } from './types';

describe('CodexSessionRegistry', () => {
  it('persists and resolves thread mappings through persistence seam', async () => {
    const store: CodexThreadMappingStore = {
      getMappedThreadId: vi.fn().mockResolvedValue(null),
      setMappedThreadId: vi.fn().mockResolvedValue(undefined),
      clearMappedThreadId: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new CodexSessionRegistry(store);

    await registry.setMappedThreadId('s1', 't1');

    expect(store.setMappedThreadId).toHaveBeenCalledWith('s1', 't1');
    expect(await registry.resolveThreadId('s1')).toBe('t1');
  });

  it('hydrates in-memory cache from persistent mapping seam', async () => {
    const store: CodexThreadMappingStore = {
      getMappedThreadId: vi.fn().mockResolvedValue('persisted-thread'),
      setMappedThreadId: vi.fn().mockResolvedValue(undefined),
      clearMappedThreadId: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new CodexSessionRegistry(store);

    const resolved = await registry.resolveThreadId('session-1');

    expect(resolved).toBe('persisted-thread');
    expect(registry.getSessionIdByThreadId('persisted-thread')).toBe('session-1');
  });

  it('enforces strict thread/session isolation when rebinding to another session', async () => {
    const registry = new CodexSessionRegistry(new InMemoryCodexThreadMappingStore());

    await registry.setMappedThreadId('s1', 't1');

    await expect(registry.setMappedThreadId('s2', 't1')).rejects.toThrow(
      'Thread t1 is already bound to session s1'
    );
  });

  it('tracks and consumes pending interactive requests', () => {
    const registry = new CodexSessionRegistry(new InMemoryCodexThreadMappingStore());

    registry.addPendingInteractiveRequest({
      sessionId: 's1',
      threadId: 't1',
      requestId: 'req-1',
      serverRequestId: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1' },
    });

    expect(registry.getPendingInteractiveRequest('s1', 'req-1')).toEqual(
      expect.objectContaining({ serverRequestId: 7 })
    );

    const consumed = registry.consumePendingInteractiveRequest('s1', 'req-1');
    expect(consumed).toEqual(expect.objectContaining({ requestId: 'req-1' }));
    expect(registry.getPendingInteractiveRequest('s1', 'req-1')).toBeNull();
  });

  it('reports active session count from thread bindings', async () => {
    const registry = new CodexSessionRegistry(new InMemoryCodexThreadMappingStore());

    await registry.setMappedThreadId('s1', 't1');
    await registry.setMappedThreadId('s2', 't2');

    expect(registry.getActiveSessionCount()).toBe(2);
  });

  it('clears persisted thread mapping when clearing a session', async () => {
    const mappings = new Map<string, string>();
    const store: CodexThreadMappingStore = {
      getMappedThreadId: vi.fn().mockImplementation((sessionId: string) => {
        return Promise.resolve(mappings.get(sessionId) ?? null);
      }),
      setMappedThreadId: vi.fn().mockImplementation((sessionId: string, threadId: string) => {
        mappings.set(sessionId, threadId);
        return Promise.resolve();
      }),
      clearMappedThreadId: vi.fn().mockImplementation((sessionId: string) => {
        mappings.delete(sessionId);
        return Promise.resolve();
      }),
    };
    const registry = new CodexSessionRegistry(store);

    await registry.setMappedThreadId('s1', 't1');
    await registry.clearSession('s1');

    expect(store.clearMappedThreadId).toHaveBeenCalledWith('s1');
    expect(registry.getSessionIdByThreadId('t1')).toBeNull();
    expect(await registry.resolveThreadId('s1')).toBeNull();
  });

  it('does not reactivate a turn that already reached a terminal state', () => {
    const registry = new CodexSessionRegistry(new InMemoryCodexThreadMappingStore());

    registry.markTurnTerminal('s1', 'turn-1');
    const activated = registry.trySetActiveTurnId('s1', 'turn-1');

    expect(activated).toBe(false);
    expect(registry.getActiveTurnId('s1')).toBeNull();
  });

  it('clears active turn when terminal notification matches active turn id', () => {
    const registry = new CodexSessionRegistry(new InMemoryCodexThreadMappingStore());

    registry.setActiveTurnId('s1', 'turn-1');
    expect(registry.getActiveTurnId('s1')).toBe('turn-1');

    registry.markTurnTerminal('s1', 'turn-1');
    expect(registry.getActiveTurnId('s1')).toBeNull();
  });
});
