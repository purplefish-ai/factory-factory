/**
 * Tests for the EventCompressionService.
 *
 * Tests the replay-time event compression for efficient WebSocket reconnect.
 */

// biome-ignore-all lint/suspicious/noExplicitAny: Test file uses `any` for type assertions on runtime event structures
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from './config.service';
import type { StoredEvent } from './event-compression.service';
import { eventCompressionService } from './event-compression.service';

// Mock configService to control compression enabled flag
vi.mock('./config.service', () => ({
  configService: {
    getCompressionConfig: vi.fn(() => ({ enabled: true })),
    getDebugConfig: vi.fn(() => ({ chatWebSocket: false })),
  },
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createStatusEvent(running: boolean): StoredEvent {
  return { type: 'status', running };
}

function createTextDeltaEvent(index: number, text: string): StoredEvent {
  return {
    type: 'claude_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      },
    } as any,
  };
}

function createThinkingDeltaEvent(index: number, thinking: string): StoredEvent {
  return {
    type: 'claude_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking },
      },
    } as any,
  };
}

function createInputJsonDeltaEvent(index: number, partialJson: string): StoredEvent {
  return {
    type: 'claude_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: partialJson },
      },
    } as any,
  };
}

function createContentBlockStartEvent(index: number, blockType: string): StoredEvent {
  return {
    type: 'claude_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index,
        content_block: { type: blockType },
      },
    } as any,
  };
}

function createContentBlockStopEvent(index: number): StoredEvent {
  return {
    type: 'claude_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'content_block_stop',
        index,
      },
    } as any,
  };
}

function createMessageStartEvent(): StoredEvent {
  return {
    type: 'claude_message',
    data: {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { role: 'assistant', content: [] },
      },
    } as any,
  };
}

function createResultEvent(): StoredEvent {
  return {
    type: 'claude_message',
    data: {
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 50 },
    } as any,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('EventCompressionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle empty events array', () => {
      const result = eventCompressionService.compressForReplay([]);
      expect(result).toEqual([]);
    });

    it('should handle single event unchanged', () => {
      const events = [createStatusEvent(true)];
      const result = eventCompressionService.compressForReplay(events);
      expect(result).toEqual(events);
    });

    it('should not mutate original events array', () => {
      const events = [createTextDeltaEvent(0, 'Hello'), createTextDeltaEvent(0, ' world')];
      const originalLength = events.length;
      const originalFirst = events[0];

      eventCompressionService.compressForReplay(events);

      expect(events.length).toBe(originalLength);
      expect(events[0]).toBe(originalFirst);
    });
  });

  // ---------------------------------------------------------------------------
  // Text Delta Compression
  // ---------------------------------------------------------------------------

  describe('text delta compression', () => {
    it('should merge consecutive text_delta events with same index', () => {
      const events = [
        createTextDeltaEvent(0, 'Hello'),
        createTextDeltaEvent(0, ' '),
        createTextDeltaEvent(0, 'world'),
        createTextDeltaEvent(0, '!'),
      ];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(1);
      const delta = (result[0].data as any).event.delta;
      expect(delta.type).toBe('text_delta');
      expect(delta.text).toBe('Hello world!');
    });

    it('should not merge text_delta events with different indices', () => {
      const events = [createTextDeltaEvent(0, 'Block 0'), createTextDeltaEvent(1, 'Block 1')];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(2);
      expect((result[0].data as any).event.delta.text).toBe('Block 0');
      expect((result[1].data as any).event.delta.text).toBe('Block 1');
    });

    it('should handle interleaved text_delta events', () => {
      const events = [
        createTextDeltaEvent(0, 'A1'),
        createTextDeltaEvent(0, 'A2'),
        createTextDeltaEvent(1, 'B1'),
        createTextDeltaEvent(1, 'B2'),
        createTextDeltaEvent(0, 'A3'),
      ];

      const result = eventCompressionService.compressForReplay(events);

      // Should be: merged(A1+A2), merged(B1+B2), A3 (separate because index switched)
      expect(result).toHaveLength(3);
      expect((result[0].data as any).event.delta.text).toBe('A1A2');
      expect((result[1].data as any).event.delta.text).toBe('B1B2');
      expect((result[2].data as any).event.delta.text).toBe('A3');
    });
  });

  // ---------------------------------------------------------------------------
  // Thinking Delta Compression
  // ---------------------------------------------------------------------------

  describe('thinking delta compression', () => {
    it('should merge consecutive thinking_delta events', () => {
      const events = [
        createThinkingDeltaEvent(0, 'Let me '),
        createThinkingDeltaEvent(0, 'think '),
        createThinkingDeltaEvent(0, 'about this...'),
      ];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(1);
      const delta = (result[0].data as any).event.delta;
      expect(delta.type).toBe('thinking_delta');
      expect(delta.thinking).toBe('Let me think about this...');
    });

    it('should not merge thinking_delta and text_delta', () => {
      const events = [createThinkingDeltaEvent(0, 'Thinking...'), createTextDeltaEvent(0, 'Text')];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(2);
      expect((result[0].data as any).event.delta.type).toBe('thinking_delta');
      expect((result[1].data as any).event.delta.type).toBe('text_delta');
    });
  });

  // ---------------------------------------------------------------------------
  // Input JSON Delta Compression
  // ---------------------------------------------------------------------------

  describe('input_json_delta compression', () => {
    it('should merge consecutive input_json_delta events', () => {
      const events = [
        createInputJsonDeltaEvent(1, '{"file'),
        createInputJsonDeltaEvent(1, '": "test'),
        createInputJsonDeltaEvent(1, '.ts"}'),
      ];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(1);
      const delta = (result[0].data as any).event.delta;
      expect(delta.type).toBe('input_json_delta');
      expect(delta.partial_json).toBe('{"file": "test.ts"}');
    });
  });

  // ---------------------------------------------------------------------------
  // Status Event Deduplication
  // ---------------------------------------------------------------------------

  describe('status event deduplication', () => {
    it('should deduplicate consecutive identical status events', () => {
      const events = [createStatusEvent(true), createStatusEvent(true), createStatusEvent(true)];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(1);
      expect(result[0].running).toBe(true);
    });

    it('should preserve status transitions', () => {
      const events = [
        createStatusEvent(true),
        createStatusEvent(true),
        createStatusEvent(false),
        createStatusEvent(false),
        createStatusEvent(true),
      ];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(3);
      expect(result[0].running).toBe(true);
      expect(result[1].running).toBe(false);
      expect(result[2].running).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Structural Events Preserved
  // ---------------------------------------------------------------------------

  describe('structural events preserved', () => {
    it('should preserve content_block_start events', () => {
      const events = [
        createContentBlockStartEvent(0, 'text'),
        createTextDeltaEvent(0, 'Hello'),
        createContentBlockStopEvent(0),
      ];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(3);
      expect((result[0].data as any).event.type).toBe('content_block_start');
      expect((result[1].data as any).event.type).toBe('content_block_delta');
      expect((result[2].data as any).event.type).toBe('content_block_stop');
    });

    it('should not merge deltas across block boundaries', () => {
      const events = [
        createTextDeltaEvent(0, 'First'),
        createContentBlockStopEvent(0),
        createContentBlockStartEvent(1, 'text'),
        createTextDeltaEvent(1, 'Second'),
      ];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(4);
      expect((result[0].data as any).event.delta.text).toBe('First');
      expect((result[3].data as any).event.delta.text).toBe('Second');
    });

    it('should preserve message_start events', () => {
      const events = [createMessageStartEvent(), createTextDeltaEvent(0, 'Hello')];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(2);
      expect((result[0].data as any).event.type).toBe('message_start');
    });

    it('should preserve result events', () => {
      const events = [createTextDeltaEvent(0, 'Response'), createResultEvent()];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(2);
      expect((result[1].data as any).type).toBe('result');
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed Sequences
  // ---------------------------------------------------------------------------

  describe('mixed sequences', () => {
    it('should handle a realistic streaming sequence', () => {
      const events = [
        createStatusEvent(true),
        createMessageStartEvent(),
        createContentBlockStartEvent(0, 'thinking'),
        createThinkingDeltaEvent(0, 'Let me '),
        createThinkingDeltaEvent(0, 'analyze '),
        createThinkingDeltaEvent(0, 'this...'),
        createContentBlockStopEvent(0),
        createContentBlockStartEvent(1, 'text'),
        createTextDeltaEvent(1, 'Here '),
        createTextDeltaEvent(1, 'is '),
        createTextDeltaEvent(1, 'the '),
        createTextDeltaEvent(1, 'answer.'),
        createContentBlockStopEvent(1),
        createResultEvent(),
        createStatusEvent(false),
      ];

      const result = eventCompressionService.compressForReplay(events);

      // Should compress:
      // - 3 thinking_deltas -> 1 (saved 2)
      // - 4 text_deltas -> 1 (saved 3)
      // Total: 15 events -> 10 events (5 saved)
      // Remaining: status, message_start, block_start, thinking(merged), block_stop,
      //            block_start, text(merged), block_stop, result, status
      expect(result).toHaveLength(10);

      // Verify thinking was merged
      const thinkingDelta = result.find(
        (e) => (e.data as any)?.event?.delta?.type === 'thinking_delta'
      );
      expect((thinkingDelta?.data as any).event.delta.thinking).toBe('Let me analyze this...');

      // Verify text was merged
      const textDelta = result.find((e) => (e.data as any)?.event?.delta?.type === 'text_delta');
      expect((textDelta?.data as any).event.delta.text).toBe('Here is the answer.');
    });

    it('should handle tool use sequence', () => {
      const events = [
        createContentBlockStartEvent(0, 'tool_use'),
        createInputJsonDeltaEvent(0, '{"command": "'),
        createInputJsonDeltaEvent(0, 'ls -la'),
        createInputJsonDeltaEvent(0, '"}'),
        createContentBlockStopEvent(0),
      ];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toHaveLength(3);
      expect((result[1].data as any).event.delta.partial_json).toBe('{"command": "ls -la"}');
    });
  });

  // ---------------------------------------------------------------------------
  // Compression Statistics
  // ---------------------------------------------------------------------------

  describe('compression statistics', () => {
    it('should return accurate stats with compressWithStats', () => {
      const events = [
        createStatusEvent(true),
        createStatusEvent(true),
        createTextDeltaEvent(0, 'A'),
        createTextDeltaEvent(0, 'B'),
        createTextDeltaEvent(0, 'C'),
        createThinkingDeltaEvent(1, 'X'),
        createThinkingDeltaEvent(1, 'Y'),
      ];

      const { compressed, stats } = eventCompressionService.compressWithStats(events);

      expect(stats.originalCount).toBe(7);
      expect(stats.compressedCount).toBe(3); // 1 status + 1 text + 1 thinking
      expect(stats.statusEventsDeduplicated).toBe(1);
      expect(stats.textDeltasMerged).toBe(2);
      expect(stats.thinkingDeltasMerged).toBe(1);
      expect(compressed).toHaveLength(3);
    });

    it('should report no merges when nothing to compress', () => {
      const events = [
        createStatusEvent(true),
        createContentBlockStartEvent(0, 'text'),
        createTextDeltaEvent(0, 'Single'),
        createContentBlockStopEvent(0),
      ];

      const { compressed, stats } = eventCompressionService.compressWithStats(events);

      expect(stats.originalCount).toBe(4);
      expect(stats.compressedCount).toBe(4);
      expect(stats.textDeltasMerged).toBe(0);
      expect(stats.statusEventsDeduplicated).toBe(0);
      expect(compressed).toHaveLength(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature Flag
  // ---------------------------------------------------------------------------

  describe('feature flag', () => {
    it('should return uncompressed when compression is disabled', () => {
      // Use the statically imported mocked configService
      vi.mocked(configService.getCompressionConfig).mockReturnValue({ enabled: false });

      const events = [createTextDeltaEvent(0, 'A'), createTextDeltaEvent(0, 'B')];

      const result = eventCompressionService.compressForReplay(events);

      expect(result).toEqual(events);
      expect(result).toHaveLength(2);

      // Restore
      vi.mocked(configService.getCompressionConfig).mockReturnValue({ enabled: true });
    });
  });
});
