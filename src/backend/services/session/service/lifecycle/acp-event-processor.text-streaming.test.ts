import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session';
import type { AgentMessage, SessionDeltaEvent } from '@/shared/acp-protocol';

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
      appendClaudeEvent: vi.fn().mockReturnValue(3),
      upsertClaudeEvent: vi.fn(),
      allocateOrder: vi.fn().mockReturnValue(2),
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

function assistantDelta(text: string): SessionDeltaEvent {
  return {
    type: 'agent_message',
    data: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

function toolStartDelta(): SessionDeltaEvent {
  return {
    type: 'agent_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
      },
    },
  };
}

function persistedText(message: AgentMessage): string | undefined {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const first = content[0];
  return first?.type === 'text' ? first.text : undefined;
}

describe('AcpEventProcessor assistant text streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('coalesces many chunks within the bounded flush interval and transmits text once', () => {
    const deps = makeDeps();
    vi.mocked(deps.sessionDomainService.allocateOrder).mockReturnValue(4);
    const processor = new AcpEventProcessor(deps);

    for (let index = 0; index < 200; index += 1) {
      processor.handleAcpDelta('sid', assistantDelta('x'));
    }

    expect(deps.sessionDomainService.upsertClaudeEvent).toHaveBeenCalledTimes(200);
    const lastPersisted = vi.mocked(deps.sessionDomainService.upsertClaudeEvent).mock.lastCall;
    expect(lastPersisted?.[0]).toBe('sid');
    expect(lastPersisted?.[2]).toBe(4);
    expect(persistedText(lastPersisted?.[1] as AgentMessage)).toBe('x'.repeat(200));
    expect(deps.sessionDomainService.emitDelta).not.toHaveBeenCalled();

    vi.advanceTimersByTime(24);
    expect(deps.sessionDomainService.emitDelta).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(deps.sessionDomainService.emitDelta).toHaveBeenCalledOnce();
    expect(deps.sessionDomainService.emitDelta).toHaveBeenCalledWith('sid', {
      type: 'assistant_text_delta',
      messageId: 'sid-4',
      order: 4,
      offset: 0,
      text: 'x'.repeat(200),
    });

    const emittedTextBytes = vi
      .mocked(deps.sessionDomainService.emitDelta)
      .mock.calls.reduce((total, call) => total + (call[1].text?.length ?? 0), 0);
    expect(emittedTextBytes).toBe(200);
  });

  it('persists complete assistant text before the live flush fires', () => {
    const sessionDomainService = new SessionDomainService();
    const emitDeltaSpy = vi.spyOn(sessionDomainService, 'emitDelta');
    const deps = makeDeps({ sessionDomainService });
    const processor = new AcpEventProcessor(deps);

    processor.handleAcpDelta('sid', assistantDelta('Hello'));
    processor.handleAcpDelta('sid', assistantDelta(' world'));

    const transcript = sessionDomainService.getTranscriptSnapshot('sid');
    expect(transcript).toHaveLength(1);
    expect(persistedText(transcript[0]?.message as AgentMessage)).toBe('Hello world');
    expect(emitDeltaSpy).not.toHaveBeenCalled();
  });

  it('emits later flush windows at the authoritative accumulated offset', () => {
    const deps = makeDeps();
    const processor = new AcpEventProcessor(deps);

    processor.handleAcpDelta('sid', assistantDelta('Hello'));
    vi.advanceTimersByTime(25);
    processor.handleAcpDelta('sid', assistantDelta(' world'));
    vi.advanceTimersByTime(25);

    expect(deps.sessionDomainService.emitDelta).toHaveBeenNthCalledWith(1, 'sid', {
      type: 'assistant_text_delta',
      messageId: 'sid-2',
      order: 2,
      offset: 0,
      text: 'Hello',
    });
    expect(deps.sessionDomainService.emitDelta).toHaveBeenNthCalledWith(2, 'sid', {
      type: 'assistant_text_delta',
      messageId: 'sid-2',
      order: 2,
      offset: 5,
      text: ' world',
    });
  });

  it('flushes before a tool boundary and allocates a new order for the next text block', () => {
    const deps = makeDeps();
    vi.mocked(deps.sessionDomainService.allocateOrder)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(4);
    const processor = new AcpEventProcessor(deps);

    processor.handleAcpDelta('sid', assistantDelta('before'));
    processor.handleAcpDelta('sid', toolStartDelta());
    processor.handleAcpDelta('sid', assistantDelta('after'));

    expect(deps.sessionDomainService.emitDelta).toHaveBeenNthCalledWith(1, 'sid', {
      type: 'assistant_text_delta',
      messageId: 'sid-2',
      order: 2,
      offset: 0,
      text: 'before',
    });
    expect(deps.sessionDomainService.emitDelta).toHaveBeenNthCalledWith(
      2,
      'sid',
      expect.objectContaining({ type: 'agent_message', order: 3 })
    );

    vi.advanceTimersByTime(25);
    expect(deps.sessionDomainService.emitDelta).toHaveBeenNthCalledWith(3, 'sid', {
      type: 'assistant_text_delta',
      messageId: 'sid-4',
      order: 4,
      offset: 0,
      text: 'after',
    });
  });

  it('closes tool-free prompt turns so the next turn gets a new text block', () => {
    const deps = makeDeps();
    vi.mocked(deps.sessionDomainService.allocateOrder)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2);
    const processor = new AcpEventProcessor(deps);

    processor.beginPromptTurn('sid');
    processor.handleAcpDelta('sid', assistantDelta('first'));
    processor.finishPromptTurn('sid');
    processor.beginPromptTurn('sid');
    processor.handleAcpDelta('sid', assistantDelta('second'));
    processor.finishPromptTurn('sid');

    expect(deps.sessionDomainService.emitDelta).toHaveBeenNthCalledWith(1, 'sid', {
      type: 'assistant_text_delta',
      messageId: 'sid-1',
      order: 1,
      offset: 0,
      text: 'first',
    });
    expect(deps.sessionDomainService.emitDelta).toHaveBeenNthCalledWith(2, 'sid', {
      type: 'assistant_text_delta',
      messageId: 'sid-2',
      order: 2,
      offset: 0,
      text: 'second',
    });
  });

  it('flushes once and cancels the pending timer during teardown', () => {
    const deps = makeDeps();
    const processor = new AcpEventProcessor(deps);

    processor.handleAcpDelta('sid', assistantDelta('final'));
    processor.clearStreamingState('sid');

    expect(deps.sessionDomainService.emitDelta).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(25);
    expect(deps.sessionDomainService.emitDelta).toHaveBeenCalledOnce();
    expect(processor.acpStreamState.has('sid')).toBe(false);
  });

  it('ignores empty assistant chunks without allocating an order', () => {
    const deps = makeDeps();
    const processor = new AcpEventProcessor(deps);

    processor.handleAcpDelta('sid', assistantDelta(''));

    expect(deps.sessionDomainService.allocateOrder).not.toHaveBeenCalled();
    expect(deps.sessionDomainService.upsertClaudeEvent).not.toHaveBeenCalled();
    expect(deps.sessionDomainService.emitDelta).not.toHaveBeenCalled();
  });
});
