import { describe, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { ClaudeSessionProviderAdapter } from './claude-session-provider-adapter';

describe('ClaudeSessionProviderAdapter', () => {
  it('maps assistant events to canonical agent_message and public agent_message delta', () => {
    const adapter = new ClaudeSessionProviderAdapter(unsafeCoerce({}));

    const canonical = adapter.toCanonicalAgentMessage(
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
      7
    );

    expect(canonical).toMatchObject({
      type: 'agent_message',
      provider: 'CLAUDE',
      kind: 'assistant_text',
      order: 7,
    });

    const delta = adapter.toPublicDeltaEvent(canonical);
    expect(delta).toEqual({
      type: 'agent_message',
      data: canonical.data,
      order: 7,
    });
  });

  it('maps user tool_result events to tool_result kind', () => {
    const adapter = new ClaudeSessionProviderAdapter(unsafeCoerce({}));

    const canonical = adapter.toCanonicalAgentMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
      },
    });

    expect(canonical.kind).toBe('tool_result');
  });

  it('delegates runtime lifecycle calls to runtime manager', async () => {
    const runtimeManager = {
      setOnClientCreated: vi.fn(),
      isStopInProgress: vi.fn().mockReturnValue(false),
      getOrCreateClient: vi.fn().mockResolvedValue({ id: 'client-1' }),
      getClient: vi.fn().mockReturnValue(undefined),
      getPendingClient: vi.fn().mockReturnValue(undefined),
      stopClient: vi.fn().mockResolvedValue(undefined),
      getClaudeProcess: vi.fn(),
      isSessionRunning: vi.fn().mockReturnValue(false),
      isSessionWorking: vi.fn().mockReturnValue(false),
      isAnySessionWorking: vi.fn().mockReturnValue(false),
      getAllActiveProcesses: vi.fn().mockReturnValue([]),
      getAllClients: vi.fn().mockReturnValue(new Map().entries()),
      stopAllClients: vi.fn().mockResolvedValue(undefined),
    };

    const adapter = new ClaudeSessionProviderAdapter(unsafeCoerce(runtimeManager));

    await adapter.getOrCreateClient(
      's1',
      unsafeCoerce({ workingDir: '/tmp', sessionId: 's1' }),
      {},
      { workspaceId: 'w1', workingDir: '/tmp' }
    );

    expect(runtimeManager.getOrCreateClient).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sessionId: 's1' }),
      {},
      { workspaceId: 'w1', workingDir: '/tmp' }
    );

    await adapter.stopClient('s1');
    expect(runtimeManager.stopClient).toHaveBeenCalledWith('s1');

    adapter.getSessionProcess('s1');
    expect(runtimeManager.getClaudeProcess).toHaveBeenCalledWith('s1');
  });

  it('routes model/thinking/rewind and interactive responses through the active client', async () => {
    const client = {
      setModel: vi.fn().mockResolvedValue(undefined),
      setMaxThinkingTokens: vi.fn().mockResolvedValue(undefined),
      rewindFiles: vi.fn().mockResolvedValue({ affected_files: ['a.ts'] }),
      approveInteractiveRequest: vi.fn(),
      denyInteractiveRequest: vi.fn(),
      answerQuestion: vi.fn(),
    };

    const runtimeManager = {
      getClient: vi.fn().mockReturnValue(client),
    };

    const adapter = new ClaudeSessionProviderAdapter(unsafeCoerce(runtimeManager));

    await adapter.setModel('s1', 'sonnet');
    await adapter.setThinkingBudget('s1', 1024);
    const rewindResponse = await adapter.rewindFiles('s1', 'msg-1', true);
    adapter.respondToPermission('s1', 'req-1', true);
    adapter.respondToPermission('s1', 'req-2', false);
    adapter.respondToQuestion('s1', 'req-3', { answer: 'yes' });

    expect(client.setModel).toHaveBeenCalledWith('sonnet');
    expect(client.setMaxThinkingTokens).toHaveBeenCalledWith(1024);
    expect(client.rewindFiles).toHaveBeenCalledWith('msg-1', true);
    expect(rewindResponse).toEqual({ affected_files: ['a.ts'] });
    expect(client.approveInteractiveRequest).toHaveBeenCalledWith('req-1');
    expect(client.denyInteractiveRequest).toHaveBeenCalledWith('req-2', 'User denied');
    expect(client.answerQuestion).toHaveBeenCalledWith('req-3', { answer: 'yes' });
  });

  it('throws a clear error when command handlers are invoked without an active client', async () => {
    const runtimeManager = {
      getClient: vi.fn().mockReturnValue(undefined),
    };

    const adapter = new ClaudeSessionProviderAdapter(unsafeCoerce(runtimeManager));

    await expect(adapter.setModel('s-missing', 'sonnet')).rejects.toThrow(
      'No active client for session: s-missing'
    );
  });
});
