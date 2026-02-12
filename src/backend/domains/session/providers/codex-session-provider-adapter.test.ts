import { describe, expect, it, vi } from 'vitest';
import { CodexSessionRegistry } from '@/backend/domains/session/codex/codex-session-registry';
import { configService } from '@/backend/services/config.service';
import { CodexSessionProviderAdapter } from './codex-session-provider-adapter';

describe('CodexSessionProviderAdapter', () => {
  it('starts a fresh thread after stop clears persisted mapping seam', async () => {
    const registry = new CodexSessionRegistry();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ threadId: 'thread-1' })
      .mockResolvedValueOnce({ threadId: 'thread-2' });

    const manager = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      request,
      stop: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
      getRegistry: () => registry,
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 99,
        startedAt: '2026-02-12T00:00:00.000Z',
        restartCount: 0,
        activeSessionCount: registry.getActiveSessionCount(),
      })),
    };

    const adapter = new CodexSessionProviderAdapter(manager as never);

    await adapter.getOrCreateClient(
      'session-1',
      { sessionId: 'session-1', workingDir: '/tmp/project' },
      {},
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' }
    );

    expect(request).toHaveBeenNthCalledWith(
      1,
      'thread/start',
      expect.objectContaining({ cwd: '/tmp/project', experimentalRawEvents: false }),
      undefined
    );

    await adapter.stopClient('session-1');
    expect(registry.getSessionIdByThreadId('thread-1')).toBeNull();

    const recreated = await adapter.getOrCreateClient(
      'session-1',
      { sessionId: 'session-1', workingDir: '/tmp/project' },
      {},
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' }
    );

    expect(recreated.threadId).toBe('thread-2');
    expect(request).toHaveBeenNthCalledWith(
      2,
      'thread/start',
      expect.objectContaining({ cwd: '/tmp/project', experimentalRawEvents: false }),
      undefined
    );
  });

  it('applies initial model preference from client options on first turn', async () => {
    const registry = new CodexSessionRegistry();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ threadId: 'thread-1' }) // thread/start
      .mockResolvedValueOnce({ turnId: 'turn-1' }); // turn/start

    const manager = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      request,
      stop: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
      getRegistry: () => registry,
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 99,
        startedAt: '2026-02-12T00:00:00.000Z',
        restartCount: 0,
        activeSessionCount: registry.getActiveSessionCount(),
      })),
    };

    const adapter = new CodexSessionProviderAdapter(manager as never);

    await adapter.getOrCreateClient(
      'session-1',
      { sessionId: 'session-1', workingDir: '/tmp/project', model: 'gpt-5' },
      {},
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' }
    );

    await adapter.sendMessage('session-1', 'Hello from Codex');

    expect(request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        input: [{ type: 'text', text: 'Hello from Codex', text_elements: [] }],
        model: 'gpt-5',
      }),
      { threadId: 'thread-1' }
    );
  });

  it('supports set_model, send turn, interrupt, and hydrate operations', async () => {
    const registry = new CodexSessionRegistry();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ threadId: 'thread-1' }) // start
      .mockResolvedValueOnce({ turnId: 'turn-1' }) // send
      .mockResolvedValueOnce({ ok: true }) // interrupt
      .mockResolvedValueOnce({ turns: [] }); // hydrate

    const manager = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      request,
      stop: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
      getRegistry: () => registry,
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 99,
        startedAt: '2026-02-12T00:00:00.000Z',
        restartCount: 0,
        activeSessionCount: registry.getActiveSessionCount(),
      })),
    };

    const adapter = new CodexSessionProviderAdapter(manager as never);

    await adapter.getOrCreateClient(
      'session-1',
      { sessionId: 'session-1', workingDir: '/tmp/project' },
      {},
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' }
    );

    await adapter.setModel('session-1', 'gpt-5');
    await adapter.sendMessage('session-1', 'Hello from Codex');
    expect(adapter.isSessionWorking('session-1')).toBe(true);

    await adapter.interruptTurn('session-1');
    expect(adapter.isSessionWorking('session-1')).toBe(false);

    const hydrated = await adapter.hydrateSession('session-1');
    expect(hydrated).toEqual({ turns: [] });

    expect(request).toHaveBeenNthCalledWith(
      2,
      'turn/start',
      expect.objectContaining({
        input: [{ type: 'text', text: 'Hello from Codex', text_elements: [] }],
        model: 'gpt-5',
      }),
      { threadId: 'thread-1' }
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      'turn/interrupt',
      expect.objectContaining({ threadId: 'thread-1', turnId: 'turn-1' }),
      { threadId: 'thread-1' }
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      'thread/read',
      expect.objectContaining({ includeTurns: true }),
      { threadId: 'thread-1' }
    );
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('fails fast when turn/start does not return turnId', async () => {
    const registry = new CodexSessionRegistry();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ threadId: 'thread-1' }) // start
      .mockResolvedValueOnce({}); // send without turnId

    const manager = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      request,
      stop: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
      getRegistry: () => registry,
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 99,
        startedAt: '2026-02-12T00:00:00.000Z',
        restartCount: 0,
        activeSessionCount: registry.getActiveSessionCount(),
      })),
    };

    const adapter = new CodexSessionProviderAdapter(manager as never);

    await adapter.getOrCreateClient(
      'session-1',
      { sessionId: 'session-1', workingDir: '/tmp/project' },
      {},
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' }
    );

    await expect(adapter.sendMessage('session-1', 'Hello from Codex')).rejects.toMatchObject({
      code: 'CODEX_TURN_ID_MISSING',
      retryable: true,
    });

    expect(adapter.isSessionWorking('session-1')).toBe(false);
  });

  it('does not mark session as working when turn already completed before response handling', async () => {
    const registry = new CodexSessionRegistry();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ threadId: 'thread-1' }) // start
      .mockResolvedValueOnce({ turnId: 'turn-1' }); // send

    const manager = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      request,
      stop: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
      getRegistry: () => registry,
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 99,
        startedAt: '2026-02-12T00:00:00.000Z',
        restartCount: 0,
        activeSessionCount: registry.getActiveSessionCount(),
      })),
    };

    const adapter = new CodexSessionProviderAdapter(manager as never);

    await adapter.getOrCreateClient(
      'session-1',
      { sessionId: 'session-1', workingDir: '/tmp/project' },
      {},
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' }
    );

    registry.markTurnTerminal('session-1', 'turn-1');
    await adapter.sendMessage('session-1', 'Hello from Codex');

    expect(adapter.isSessionWorking('session-1')).toBe(false);
  });

  it('returns canonical unsupported operation errors for thinking budget and rewind', async () => {
    const adapter = new CodexSessionProviderAdapter({
      ensureStarted: vi.fn(),
      request: vi.fn(),
      stop: vi.fn(),
      respond: vi.fn(),
      getRegistry: () => new CodexSessionRegistry(),
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 1,
        startedAt: null,
        restartCount: 0,
        activeSessionCount: 0,
      })),
    } as never);

    await expect(adapter.setThinkingBudget('session-1', 2048)).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      metadata: { operation: 'set_thinking_budget' },
    });

    await expect(adapter.rewindFiles('session-1', 'msg-1')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      metadata: { operation: 'rewind_files' },
    });
  });

  it('maps permission and question responses back to server request ids', async () => {
    const registry = new CodexSessionRegistry();
    const manager = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockResolvedValue({ threadId: 'thread-1' }),
      stop: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
      getRegistry: () => registry,
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 99,
        startedAt: '2026-02-12T00:00:00.000Z',
        restartCount: 0,
        activeSessionCount: registry.getActiveSessionCount(),
      })),
    };

    const adapter = new CodexSessionProviderAdapter(manager as never);

    await adapter.getOrCreateClient(
      'session-1',
      { sessionId: 'session-1', workingDir: '/tmp/project' },
      {},
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' }
    );

    registry.addPendingInteractiveRequest({
      sessionId: 'session-1',
      threadId: 'thread-1',
      requestId: 'approval-1',
      serverRequestId: 101,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });

    adapter.respondToPermission('session-1', 'approval-1', true);

    expect(manager.respond).toHaveBeenCalledWith(101, { decision: 'accept' });

    registry.addPendingInteractiveRequest({
      sessionId: 'session-1',
      threadId: 'thread-1',
      requestId: 'question-1',
      serverRequestId: 202,
      method: 'item/tool/requestUserInput',
      params: {},
    });

    vi.spyOn(configService, 'getCodexAppServerConfig').mockReturnValue({
      command: 'codex',
      args: ['app-server'],
      requestTimeoutMs: 30_000,
      handshakeTimeoutMs: 15_000,
      requestUserInputEnabled: true,
    });

    adapter.respondToQuestion('session-1', 'question-1', { answer: 'yes' });

    expect(manager.respond).toHaveBeenCalledWith(202, {
      answers: {
        answer: {
          answers: ['yes'],
        },
      },
    });
  });

  it('rejects unsupported interactive requests with JSON-RPC error responses', async () => {
    const registry = new CodexSessionRegistry();
    const manager = {
      ensureStarted: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockResolvedValue({ threadId: 'thread-1' }),
      stop: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn(),
      getRegistry: () => registry,
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 99,
        startedAt: '2026-02-12T00:00:00.000Z',
        restartCount: 0,
        activeSessionCount: registry.getActiveSessionCount(),
      })),
    };

    const adapter = new CodexSessionProviderAdapter(manager as never);

    await adapter.getOrCreateClient(
      'session-1',
      { sessionId: 'session-1', workingDir: '/tmp/project' },
      {},
      { workspaceId: 'workspace-1', workingDir: '/tmp/project' }
    );

    registry.addPendingInteractiveRequest({
      sessionId: 'session-1',
      threadId: 'thread-1',
      requestId: 'unsupported-1',
      serverRequestId: 'req-77',
      method: 'item/tool/requestUserInput',
      params: {},
    });

    adapter.rejectInteractiveRequest('session-1', 'unsupported-1', {
      message: 'Unsupported Codex interactive request: item/tool/requestUserInput',
      data: {
        code: 'UNSUPPORTED_OPERATION',
        operation: 'question_response',
      },
    });

    expect(manager.respond).toHaveBeenCalledWith(
      'req-77',
      {
        code: -32_601,
        message: 'Unsupported Codex interactive request: item/tool/requestUserInput',
        data: {
          code: 'UNSUPPORTED_OPERATION',
          operation: 'question_response',
        },
      },
      true
    );
  });

  it('emits Claude-compatible public deltas for CODEX canonical messages', () => {
    const adapter = new CodexSessionProviderAdapter({
      ensureStarted: vi.fn(),
      request: vi.fn(),
      stop: vi.fn(),
      respond: vi.fn(),
      getRegistry: () => new CodexSessionRegistry(),
      getStatus: vi.fn(() => ({
        state: 'ready',
        unavailableReason: null,
        pid: 1,
        startedAt: null,
        restartCount: 0,
        activeSessionCount: 0,
      })),
    } as never);

    const canonical = adapter.toCanonicalAgentMessage({ kind: 'assistant_text', text: 'hello' }, 7);
    expect(canonical).toMatchObject({ provider: 'CODEX', kind: 'assistant_text', order: 7 });

    const delta = adapter.toPublicDeltaEvent(canonical);
    expect(delta).toEqual(
      expect.objectContaining({
        type: 'claude_message',
        order: 7,
      })
    );
  });
});
