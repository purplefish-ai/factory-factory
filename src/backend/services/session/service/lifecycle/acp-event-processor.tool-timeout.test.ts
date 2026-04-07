import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getCurrentProcessEnv: () => ({ ...process.env }),
}));

vi.mock('@/backend/services/session/service/acp', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AcpEventTranslator: class MockAcpEventTranslator {
      translateSessionUpdate = vi.fn().mockReturnValue([]);
    },
  };
});

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

function makeDeps(
  overrides: Partial<AcpEventProcessorDependencies> = {}
): AcpEventProcessorDependencies {
  return {
    runtimeManager: {
      getClient: vi.fn(),
      isSessionWorking: vi.fn().mockReturnValue(true),
    } as unknown as AcpEventProcessorDependencies['runtimeManager'],
    sessionDomainService: {
      emitDelta: vi.fn(),
      appendClaudeEvent: vi.fn().mockReturnValue(1),
      upsertClaudeEvent: vi.fn(),
      allocateOrder: vi.fn().mockReturnValue(1),
    } as unknown as AcpEventProcessorDependencies['sessionDomainService'],
    sessionPermissionService: {
      createPermissionBridge: vi.fn().mockReturnValue({ cancelAll: vi.fn() }),
      handlePermissionRequest: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionPermissionService'],
    sessionConfigService: {
      applyConfigOptionsUpdateDelta: vi.fn(),
    } as unknown as AcpEventProcessorDependencies['sessionConfigService'],
    onToolCallTimeout: vi.fn(),
    ...overrides,
  };
}

/** Emit a tool_use content_block_start delta (tool start event). */
function toolStartDelta(toolUseId: string, toolName: string, input: Record<string, unknown> = {}) {
  return {
    type: 'agent_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: toolUseId, name: toolName, input },
      },
    },
  };
}

/** Emit a tool_result user message delta (tool completion event). */
function toolResultDelta(toolUseId: string) {
  return {
    type: 'agent_message',
    data: {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
      },
    },
  };
}

describe('AcpEventProcessor tool call timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('fires onToolCallTimeout when a tool call exceeds the timeout', () => {
    const onToolCallTimeout = vi.fn();
    const processor = new AcpEventProcessor(
      makeDeps({ onToolCallTimeout, toolCallTimeoutMs: 1000 })
    );
    processor.registerSessionContext('sid', { workspaceId: 'ws', workingDir: '/tmp' });
    processor.beginPromptTurn('sid');

    processor.handleAcpDelta('sid', toolStartDelta('tool-1', 'Bash') as never);

    expect(onToolCallTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1001);

    expect(onToolCallTimeout).toHaveBeenCalledOnce();
    expect(onToolCallTimeout).toHaveBeenCalledWith('sid', 'tool-1', 'Bash');
  });

  it('does not fire if the tool call completes before the timeout', () => {
    const onToolCallTimeout = vi.fn();
    const processor = new AcpEventProcessor(
      makeDeps({ onToolCallTimeout, toolCallTimeoutMs: 1000 })
    );
    processor.registerSessionContext('sid', { workspaceId: 'ws', workingDir: '/tmp' });
    processor.beginPromptTurn('sid');

    processor.handleAcpDelta('sid', toolStartDelta('tool-1', 'Bash') as never);
    vi.advanceTimersByTime(500);
    processor.handleAcpDelta('sid', toolResultDelta('tool-1') as never);
    vi.advanceTimersByTime(1000);

    expect(onToolCallTimeout).not.toHaveBeenCalled();
  });

  it('clears all timers when clearPendingToolCalls is called', () => {
    const onToolCallTimeout = vi.fn();
    const processor = new AcpEventProcessor(
      makeDeps({ onToolCallTimeout, toolCallTimeoutMs: 1000 })
    );
    processor.registerSessionContext('sid', { workspaceId: 'ws', workingDir: '/tmp' });
    processor.beginPromptTurn('sid');

    processor.handleAcpDelta('sid', toolStartDelta('tool-1', 'Bash') as never);
    processor.handleAcpDelta('sid', toolStartDelta('tool-2', 'Read') as never);

    processor.clearPendingToolCalls('sid');
    vi.advanceTimersByTime(2000);

    expect(onToolCallTimeout).not.toHaveBeenCalled();
  });

  it('clears all timers when clearSessionState is called', () => {
    const onToolCallTimeout = vi.fn();
    const processor = new AcpEventProcessor(
      makeDeps({ onToolCallTimeout, toolCallTimeoutMs: 1000 })
    );
    processor.registerSessionContext('sid', { workspaceId: 'ws', workingDir: '/tmp' });
    processor.beginPromptTurn('sid');

    processor.handleAcpDelta('sid', toolStartDelta('tool-1', 'Bash') as never);

    processor.clearSessionState('sid');
    vi.advanceTimersByTime(2000);

    expect(onToolCallTimeout).not.toHaveBeenCalled();
  });

  it('handles multiple concurrent tool calls independently', () => {
    const onToolCallTimeout = vi.fn();
    const processor = new AcpEventProcessor(
      makeDeps({ onToolCallTimeout, toolCallTimeoutMs: 1000 })
    );
    processor.registerSessionContext('sid', { workspaceId: 'ws', workingDir: '/tmp' });
    processor.beginPromptTurn('sid');

    processor.handleAcpDelta('sid', toolStartDelta('tool-1', 'Bash') as never);
    processor.handleAcpDelta('sid', toolStartDelta('tool-2', 'Read') as never);

    // Complete tool-1 before timeout
    vi.advanceTimersByTime(500);
    processor.handleAcpDelta('sid', toolResultDelta('tool-1') as never);

    // Let tool-2 time out
    vi.advanceTimersByTime(600);

    expect(onToolCallTimeout).toHaveBeenCalledOnce();
    expect(onToolCallTimeout).toHaveBeenCalledWith('sid', 'tool-2', 'Read');
  });

  it('does not timeout requestUserInput tool calls while waiting for user response', () => {
    const onToolCallTimeout = vi.fn();
    const processor = new AcpEventProcessor(
      makeDeps({ onToolCallTimeout, toolCallTimeoutMs: 1000 })
    );
    processor.registerSessionContext('sid', { workspaceId: 'ws', workingDir: '/tmp' });
    processor.beginPromptTurn('sid');

    processor.handleAcpDelta(
      'sid',
      toolStartDelta('tool-user-input', 'item/tool/requestUserInput', {
        questions: [{ id: 'q1', question: 'Continue?' }],
      }) as never
    );
    vi.advanceTimersByTime(2000);

    expect(onToolCallTimeout).not.toHaveBeenCalled();
  });

  it('does not timeout ExitPlanMode approval tool calls while waiting for user response', () => {
    const onToolCallTimeout = vi.fn();
    const processor = new AcpEventProcessor(
      makeDeps({ onToolCallTimeout, toolCallTimeoutMs: 1000 })
    );
    processor.registerSessionContext('sid', { workspaceId: 'ws', workingDir: '/tmp' });
    processor.beginPromptTurn('sid');

    processor.handleAcpDelta(
      'sid',
      toolStartDelta('tool-exit-plan', 'ExitPlanMode', {
        type: 'ExitPlanMode',
        plan: { type: 'text', text: '- ship it' },
      }) as never
    );
    vi.advanceTimersByTime(2000);

    expect(onToolCallTimeout).not.toHaveBeenCalled();
  });
});
