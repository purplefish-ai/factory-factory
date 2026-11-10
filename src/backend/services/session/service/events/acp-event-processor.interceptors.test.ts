import { beforeEach, describe, expect, it, vi } from 'vitest';
import { interceptorRegistry } from '@/backend/interceptors/registry';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
}));

vi.mock('@/backend/interceptors/registry', () => ({
  interceptorRegistry: {
    notifyToolStart: vi.fn(),
    notifyToolComplete: vi.fn(),
  },
}));

vi.mock('@/backend/services/session/service/logging/acp-trace-logger.service', () => ({
  acpTraceLogger: { log: vi.fn() },
}));

vi.mock('@/backend/services/session/service/logging/session-file-logger.service', () => ({
  sessionFileLogger: { log: vi.fn() },
}));

import type { AcpEventProcessorDependencies } from './acp-event-processor';
import { AcpEventProcessor } from './acp-event-processor';

function makeDeps(): AcpEventProcessorDependencies {
  return {
    runtimeManager: {
      getClient: vi.fn(),
      isSessionWorking: vi.fn().mockReturnValue(true),
      isSessionPromptInFlight: vi.fn().mockReturnValue(false),
    } as unknown as AcpEventProcessorDependencies['runtimeManager'],
    sessionDomainService: {
      getRuntimeSnapshot: vi.fn().mockReturnValue({ phase: 'idle' }),
      setRuntimeSnapshot: vi.fn(),
      emitDelta: vi.fn(),
      appendClaudeEvent: vi.fn(),
      upsertClaudeEvent: vi.fn(),
      allocateOrder: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionDomainService'],
    sessionPermissionService: {
      createPermissionBridge: vi.fn().mockReturnValue({ cancelAll: vi.fn() }),
      handlePermissionRequest: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionPermissionService'],
    sessionConfigService: {
      applyConfigOptionsUpdateDelta: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionConfigService'],
    onToolCallTimeout: vi.fn(),
  };
}

const PR_URL = 'https://github.com/purplefish-ai/factory-factory/pull/2648';

function makeProcessor() {
  const deps = makeDeps();
  const processor = new AcpEventProcessor(deps);
  processor.registerSessionContext('db-session-1', {
    workspaceId: 'workspace-1',
    workingDir: '/tmp/workspace-1',
    provider: 'CLAUDE',
  });
  const { onAcpEvent } = processor.createRuntimeEventHandler('db-session-1');
  if (!onAcpEvent) {
    throw new Error('Expected an ACP runtime event handler');
  }
  return { deps, processor, onAcpEvent };
}

/** Claude announces a Bash call first, then its command, output and exit separately. */
function claudeBashUpdates(toolCallId: string, command: string, output: string) {
  return [
    {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Terminal',
      kind: 'execute',
      status: 'pending',
      content: [{ type: 'terminal', terminalId: toolCallId }],
      _meta: { claudeCode: { toolName: 'Bash' }, terminal_info: { terminal_id: toolCallId } },
    },
    { sessionUpdate: 'tool_call_update', toolCallId, title: command },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      rawInput: { command, description: 'Open the PR' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      _meta: { terminal_output_delta: { terminal_id: toolCallId, data: output } },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      _meta: { terminal_exit: { terminal_id: toolCallId, exit_code: 0, signal: null } },
    },
  ] as const;
}

describe('AcpEventProcessor tool interceptors', () => {
  beforeEach(() => {
    vi.mocked(interceptorRegistry.notifyToolComplete).mockClear();
    vi.mocked(interceptorRegistry.notifyToolStart).mockClear();
  });

  it('gives interceptors the command Claude sends after announcing a tool call', () => {
    const { onAcpEvent } = makeProcessor();

    for (const update of claudeBashUpdates('toolu_1', 'gh pr create --fill', `${PR_URL}\n`)) {
      onAcpEvent('db-session-1', { type: 'acp_session_update', update: update as never });
    }

    expect(interceptorRegistry.notifyToolComplete).toHaveBeenCalledOnce();
    expect(interceptorRegistry.notifyToolComplete).toHaveBeenCalledWith(
      {
        toolUseId: 'toolu_1',
        toolName: 'Bash',
        input: { command: 'gh pr create --fill', description: 'Open the PR' },
        output: { content: `${PR_URL}\n`, isError: false },
      },
      expect.not.objectContaining({ subagentId: expect.anything() })
    );
  });

  it('reports completed sub-agent tool calls without touching the parent transcript', () => {
    const { deps, onAcpEvent } = makeProcessor();

    for (const update of claudeBashUpdates(
      'toolu_child',
      'gh pr create --head fix-branch --fill',
      `${PR_URL}\n`
    )) {
      onAcpEvent('db-session-1', {
        type: 'acp_subagent_tool_update',
        subagentId: 'child-1',
        update: update as never,
      });
    }

    expect(interceptorRegistry.notifyToolStart).not.toHaveBeenCalled();
    expect(interceptorRegistry.notifyToolComplete).toHaveBeenCalledOnce();
    expect(interceptorRegistry.notifyToolComplete).toHaveBeenCalledWith(
      {
        toolUseId: 'toolu_child',
        toolName: 'Bash',
        input: { command: 'gh pr create --head fix-branch --fill', description: 'Open the PR' },
        output: { content: `${PR_URL}\n`, isError: false },
      },
      expect.objectContaining({
        sessionId: 'db-session-1',
        workspaceId: 'workspace-1',
        workingDir: '/tmp/workspace-1',
        subagentId: 'child-1',
      })
    );
    expect(deps.sessionDomainService.emitDelta).not.toHaveBeenCalled();
    expect(deps.sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
    expect(deps.sessionDomainService.upsertClaudeEvent).not.toHaveBeenCalled();
  });

  it('reports failed sub-agent tool calls as errors', () => {
    const { onAcpEvent } = makeProcessor();
    const send = (update: Record<string, unknown>) =>
      onAcpEvent('db-session-1', {
        type: 'acp_subagent_tool_update',
        subagentId: 'child-1',
        update: update as never,
      });

    send({
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-1',
      title: 'gh pr create --fill',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: "/bin/zsh -lc 'gh pr create --fill'" },
    });
    send({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'exec-1',
      _meta: { terminal_output_delta: { terminal_id: 'exec-1', data: 'no commits\n' } },
    });
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'failed' });

    expect(interceptorRegistry.notifyToolComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'gh pr create --fill',
        input: { command: "/bin/zsh -lc 'gh pr create --fill'" },
        output: { content: 'no commits\n', isError: true },
      }),
      expect.objectContaining({ subagentId: 'child-1' })
    );
  });

  it('does not repeat sub-agent tool side effects during history replay', () => {
    const { deps, processor, onAcpEvent } = makeProcessor();
    vi.mocked(deps.runtimeManager.isSessionWorking).mockReturnValue(true);
    processor.setReplaySuppression('db-session-1', true);

    for (const update of claudeBashUpdates('toolu_old', 'gh pr create --fill', `${PR_URL}\n`)) {
      onAcpEvent('db-session-1', {
        type: 'acp_subagent_tool_update',
        subagentId: 'child-1',
        update: update as never,
      });
    }

    expect(interceptorRegistry.notifyToolComplete).not.toHaveBeenCalled();
  });
});
