import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AcpEventTranslator } from './acp-event-translator';

function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof import('@/backend/services/logger.service').createLogger>;
}

function createTranslator() {
  const logger = createMockLogger();
  const translator = new AcpEventTranslator(logger);
  return { translator, logger };
}

type TranslatorSessionUpdate = Parameters<AcpEventTranslator['translateSessionUpdate']>[0];

describe('AcpEventTranslator', () => {
  describe('agent_message_chunk', () => {
    it('translates text content to agent_message delta', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello world' },
      } as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'agent_message',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello world' }],
          },
        },
      });
    });

    it('returns empty array for non-text content', () => {
      const { translator, logger } = createTranslator();
      const update = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'base64data', mimeType: 'image/png' },
      } as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'agent_message_chunk: non-text content type, skipping',
        expect.objectContaining({ contentType: 'image' })
      );
    });

    it('returns empty array for undefined content without throwing', () => {
      const { translator, logger } = createTranslator();
      // Force undefined content via type assertion
      const update = {
        sessionUpdate: 'agent_message_chunk',
        content: undefined,
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'agent_message_chunk: missing content',
        expect.any(Object)
      );
    });
  });

  describe('agent_thought_chunk', () => {
    it('translates text to thinking content_block', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me think about this...' },
      } as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'agent_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'thinking_delta',
              thinking: 'Let me think about this...',
            },
          },
        },
      });
    });

    it('returns empty array for missing content without throwing', () => {
      const { translator, logger } = createTranslator();
      const update = {
        sessionUpdate: 'agent_thought_chunk',
        content: undefined,
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'agent_thought_chunk: missing content',
        expect.any(Object)
      );
    });
  });

  describe('tool_call', () => {
    it('emits content_block_start and tool_progress', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-001',
        title: 'Read file',
        rawInput: { path: '/foo/bar.ts' },
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: '/foo/bar.ts' }],
      } as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: 'agent_message',
        data: {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'tc-001',
              name: 'Read file',
              input: { path: '/foo/bar.ts' },
            },
          },
        },
      });
      expect(events[1]).toMatchObject({
        type: 'tool_progress',
        tool_use_id: 'tc-001',
        tool_name: 'Read file',
        acpKind: 'read',
        acpStatus: 'in_progress',
      });
      // Verify locations are passed through
      expect((events[1] as Record<string, unknown>).acpLocations).toEqual([
        { path: '/foo/bar.ts' },
      ]);
    });

    it('returns empty array for missing toolCallId without throwing', () => {
      const { translator, logger } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call',
        toolCallId: '',
        title: 'Read file',
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'tool_call: missing toolCallId or title',
        expect.any(Object)
      );
    });

    it('defaults rawInput to empty object when undefined', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-002',
        title: 'ListDir',
        rawInput: undefined,
        kind: 'read',
        status: 'pending',
        locations: [],
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(2);
      const contentBlock = (events[0] as Record<string, unknown>).data as Record<string, unknown>;
      const event = contentBlock.event as Record<string, unknown>;
      const block = event.content_block as Record<string, unknown>;
      expect(block.input).toEqual({});
    });

    it('emits terminal tool_result when tool_call status is completed', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-003',
        title: 'Run',
        status: 'completed',
        content: [{ type: 'text', text: 'done from tool_call' }],
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(3);
      expect((events[1] as Record<string, unknown>).elapsed_time_seconds).toBe(0);
      expect(events[2]).toEqual({
        type: 'agent_message',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tc-003', content: 'done from tool_call' },
            ],
          },
        },
      });
    });

    it('falls back to rawOutput when terminal tool_call content is missing', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-004',
        title: 'Run',
        status: 'failed',
        rawOutput: { error: 'boom' },
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(3);
      expect(events[2]).toEqual({
        type: 'agent_message',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tc-004',
                content: '{"error":"boom"}',
                is_error: true,
              },
            ],
          },
        },
      });
    });
  });

  describe('tool_call_update', () => {
    it('emits tool_progress with status transitions', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-001',
        title: 'Read file',
        status: 'in_progress',
        kind: 'read',
        locations: [{ path: '/foo.ts' }],
        content: null,
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_progress',
        tool_use_id: 'tc-001',
        tool_name: 'Read file',
        acpStatus: 'in_progress',
        acpKind: 'read',
      });
      expect((events[0] as Record<string, unknown>).elapsed_time_seconds).toBeUndefined();
    });

    it('includes elapsed_time_seconds and tool_result when status is completed', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-001',
        status: 'completed',
        content: [{ type: 'text', text: 'done' }],
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(2);
      expect((events[0] as Record<string, unknown>).elapsed_time_seconds).toBe(0);
      // Second event is the tool_result for frontend pairing
      expect(events[1]).toEqual({
        type: 'agent_message',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tc-001', content: 'done' }],
          },
        },
      });
    });

    it('includes elapsed_time_seconds and error tool_result when status is failed', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-001',
        status: 'failed',
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(2);
      expect((events[0] as Record<string, unknown>).elapsed_time_seconds).toBe(0);
      expect(events[1]).toEqual({
        type: 'agent_message',
        data: {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tc-001', content: '', is_error: true }],
          },
        },
      });
    });

    it('handles null fields with defaults (no throw)', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-001',
        title: null,
        status: null,
        kind: null,
        locations: null,
        content: null,
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_progress',
        tool_use_id: 'tc-001',
        acpLocations: [],
      });
    });

    it('returns empty array for missing toolCallId', () => {
      const { translator, logger } = createTranslator();
      const update = {
        sessionUpdate: 'tool_call_update',
        toolCallId: '',
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('plan', () => {
    it('emits task_notification with structured JSON entries', () => {
      const { translator } = createTranslator();
      const entries = [
        { content: 'Read the file', status: 'completed', priority: 'high' },
        { content: 'Write tests', status: 'in_progress', priority: 'medium' },
      ];
      const update = {
        sessionUpdate: 'plan',
        entries,
      } as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'task_notification',
        message: JSON.stringify({ type: 'acp_plan', entries }),
      });
    });

    it('handles undefined entries with empty array', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'plan',
        entries: undefined,
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      const parsed = JSON.parse((events[0] as Record<string, unknown>).message as string);
      expect(parsed.entries).toEqual([]);
    });
  });

  describe('available_commands_update', () => {
    it('emits slash_commands with mapped CommandInfo', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          {
            name: 'create_plan',
            description: 'Create an execution plan',
            input: { hint: '<description>' },
          },
          {
            name: 'help',
            description: 'Show help',
            input: null,
          },
        ],
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'slash_commands',
        slashCommands: [
          {
            name: 'create_plan',
            description: 'Create an execution plan',
            argumentHint: '<description>',
          },
          {
            name: 'help',
            description: 'Show help',
            argumentHint: undefined,
          },
        ],
      });
    });

    it('handles empty commands array', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
      } as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'slash_commands',
        slashCommands: [],
      });
    });

    it('handles undefined availableCommands', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'available_commands_update',
        availableCommands: undefined,
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect((events[0] as Record<string, unknown>).slashCommands).toEqual([]);
    });
  });

  describe('usage_update', () => {
    it('emits result event with usage data', () => {
      const { translator } = createTranslator();
      const update = {
        sessionUpdate: 'usage_update',
        size: 200_000,
        used: 15_000,
        cost: { amount: 0.05, currency: 'USD' },
      } as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'agent_message',
        data: {
          type: 'result',
          result: update,
        },
      });
    });
  });

  describe('context_compaction', () => {
    it('emits compacting_start for active state strings', () => {
      const { translator } = createTranslator();
      const update: TranslatorSessionUpdate = {
        sessionUpdate: 'context_compaction',
        state: 'started',
      };

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([{ type: 'compacting_start' }]);
    });

    it('emits compacting_end for inactive boolean state', () => {
      const { translator } = createTranslator();
      const update: TranslatorSessionUpdate = {
        sessionUpdate: 'context_compaction',
        compacting: false,
      };

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([{ type: 'compacting_end' }]);
    });

    it('supports nested payloads', () => {
      const { translator } = createTranslator();
      const update: TranslatorSessionUpdate = {
        sessionUpdate: 'context_compaction',
        payload: { status: 'in_progress' },
      };

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([{ type: 'compacting_start' }]);
    });

    it('returns empty array and logs warning for unknown payload shape', () => {
      const { translator, logger } = createTranslator();
      const update: TranslatorSessionUpdate = {
        sessionUpdate: 'context_compaction',
        payload: { unknown: 'value' },
      };

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'context_compaction: unknown payload shape',
        expect.objectContaining({ update })
      );
    });
  });

  describe('deferred types', () => {
    it.each([
      'config_option_update',
      'current_mode_update',
      'session_info_update',
      'user_message_chunk',
    ] as const)('%s returns empty array', (sessionUpdate) => {
      const { translator } = createTranslator();
      // Build a minimal update for each deferred type
      const update = { sessionUpdate } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([]);
    });
  });

  describe('unknown type', () => {
    it('returns empty array and logs warning', () => {
      const { translator, logger } = createTranslator();
      const update = {
        sessionUpdate: 'totally_unknown_type',
      } as unknown as SessionUpdate;

      const events = translator.translateSessionUpdate(update);

      expect(events).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Unknown ACP session update type',
        expect.objectContaining({ sessionUpdate: 'totally_unknown_type' })
      );
    });
  });
});
