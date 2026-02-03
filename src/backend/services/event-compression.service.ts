/**
 * Event Compression Service
 *
 * Compresses stored WebSocket events for efficient replay on reconnect.
 * Operates at replay time (read-only) - never modifies stored events.
 *
 * Compression strategies:
 * 1. Merge consecutive text_delta events into single delta (same content block index)
 * 2. Merge consecutive thinking_delta events into single delta (same content block index)
 * 3. Merge consecutive input_json_delta events into single delta (same content block index)
 * 4. Deduplicate consecutive identical status events
 *
 * What stays separate:
 * - content_block_start / content_block_stop (structural boundaries)
 * - message_start / message_stop (message boundaries)
 * - Different content block indices (belong to different blocks)
 * - User messages with tool_result (complete messages)
 * - Result messages (final stats)
 */

import { configService } from './config.service';
import { createLogger } from './logger.service';

const logger = createLogger('event-compression');

// =============================================================================
// Types
// =============================================================================

/**
 * Stored event shape from message-state.service.ts.
 * Uses `unknown` for data to match the actual stored type.
 */
export interface StoredEvent {
  type: string;
  data?: unknown;
  running?: boolean;
  processAlive?: boolean;
}

/** Compression statistics for monitoring */
export interface CompressionStats {
  originalCount: number;
  compressedCount: number;
  textDeltasMerged: number;
  thinkingDeltasMerged: number;
  jsonDeltasMerged: number;
  statusEventsDeduplicated: number;
}

/** Delta types we can merge */
type MergeableDeltaType = 'text_delta' | 'thinking_delta' | 'input_json_delta';

/** Internal type for accessing stream event data at runtime */
interface StreamEventData {
  type: string;
  event?: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
  };
}

// =============================================================================
// Service
// =============================================================================

class EventCompressionService {
  /**
   * Compress events for replay.
   * Returns a new array - never mutates input.
   *
   * Single-pass O(n) algorithm that merges consecutive deltas of the same type.
   */
  compressForReplay(events: StoredEvent[]): StoredEvent[] {
    if (!configService.getCompressionConfig().enabled) {
      return events;
    }

    if (events.length === 0) {
      return [];
    }

    const result: StoredEvent[] = [];
    let i = 0;

    while (i < events.length) {
      const event = events[i];

      // Try to compress consecutive content_block_delta events
      if (this.isContentBlockDelta(event)) {
        const { compressed, endIndex } = this.compressConsecutiveDeltas(events, i);
        result.push(compressed);
        i = endIndex + 1;
        continue;
      }

      // Deduplicate consecutive status events with same running value
      if (this.isStatusEvent(event)) {
        const { deduplicated, endIndex } = this.deduplicateStatusEvents(events, i);
        result.push(deduplicated);
        i = endIndex + 1;
        continue;
      }

      // Keep other events as-is
      result.push(event);
      i++;
    }

    return result;
  }

  /**
   * Compress events and return both compressed events and statistics.
   * Used when logging is enabled to provide visibility into compression effectiveness.
   */
  compressWithStats(events: StoredEvent[]): { compressed: StoredEvent[]; stats: CompressionStats } {
    const stats: CompressionStats = {
      originalCount: events.length,
      compressedCount: 0,
      textDeltasMerged: 0,
      thinkingDeltasMerged: 0,
      jsonDeltasMerged: 0,
      statusEventsDeduplicated: 0,
    };

    if (!configService.getCompressionConfig().enabled) {
      stats.compressedCount = events.length;
      return { compressed: events, stats };
    }

    if (events.length === 0) {
      return { compressed: [], stats };
    }

    const result: StoredEvent[] = [];
    let i = 0;

    while (i < events.length) {
      const processed = this.processEventWithStats(events, i, stats);
      result.push(processed.output);
      i = processed.nextIndex;
    }

    stats.compressedCount = result.length;
    return { compressed: result, stats };
  }

  /**
   * Process a single event, potentially compressing it with subsequent events.
   * Updates stats in place and returns the output event and next index.
   */
  private processEventWithStats(
    events: StoredEvent[],
    i: number,
    stats: CompressionStats
  ): { output: StoredEvent; nextIndex: number } {
    const event = events[i];

    // Try to compress consecutive content_block_delta events
    if (this.isContentBlockDelta(event)) {
      const { compressed, endIndex, deltaType } = this.compressConsecutiveDeltasWithType(events, i);
      this.updateDeltaStats(stats, deltaType, endIndex - i);
      return { output: compressed, nextIndex: endIndex + 1 };
    }

    // Deduplicate consecutive status events with same running value
    if (this.isStatusEvent(event)) {
      const { deduplicated, endIndex } = this.deduplicateStatusEvents(events, i);
      stats.statusEventsDeduplicated += endIndex - i;
      return { output: deduplicated, nextIndex: endIndex + 1 };
    }

    // Keep other events as-is
    return { output: event, nextIndex: i + 1 };
  }

  /**
   * Update delta merge stats based on delta type.
   */
  private updateDeltaStats(
    stats: CompressionStats,
    deltaType: MergeableDeltaType | null,
    mergedCount: number
  ): void {
    if (mergedCount <= 0 || !deltaType) {
      return;
    }
    if (deltaType === 'text_delta') {
      stats.textDeltasMerged += mergedCount;
    } else if (deltaType === 'thinking_delta') {
      stats.thinkingDeltasMerged += mergedCount;
    } else if (deltaType === 'input_json_delta') {
      stats.jsonDeltasMerged += mergedCount;
    }
  }

  /**
   * Log compression statistics if debug logging is enabled.
   */
  logCompressionStats(sessionId: string, stats: CompressionStats): void {
    if (stats.originalCount === stats.compressedCount) {
      return; // No compression occurred
    }

    const ratio = stats.compressedCount > 0 ? stats.originalCount / stats.compressedCount : 0;
    logger.info('Event compression applied', {
      sessionId,
      originalCount: stats.originalCount,
      compressedCount: stats.compressedCount,
      ratio: ratio.toFixed(2),
      textDeltasMerged: stats.textDeltasMerged,
      thinkingDeltasMerged: stats.thinkingDeltasMerged,
      jsonDeltasMerged: stats.jsonDeltasMerged,
      statusEventsDeduplicated: stats.statusEventsDeduplicated,
    });
  }

  // =============================================================================
  // Private Helpers
  // =============================================================================

  /**
   * Safely cast event data to our internal stream event type for inspection.
   */
  private asStreamData(event: StoredEvent): StreamEventData | null {
    if (event.type !== 'claude_message' || !event.data) {
      return null;
    }
    return event.data as StreamEventData;
  }

  /**
   * Check if an event is a content_block_delta stream event.
   */
  private isContentBlockDelta(event: StoredEvent): boolean {
    const data = this.asStreamData(event);
    if (!data || data.type !== 'stream_event' || !data.event) {
      return false;
    }
    return data.event.type === 'content_block_delta';
  }

  /**
   * Check if an event is a status event.
   */
  private isStatusEvent(event: StoredEvent): boolean {
    return event.type === 'status';
  }

  /**
   * Extract the delta type from a content_block_delta event.
   */
  private getDeltaType(event: StoredEvent): MergeableDeltaType | null {
    const data = this.asStreamData(event);
    if (!data?.event || data.event.type !== 'content_block_delta') {
      return null;
    }

    const deltaType = data.event.delta?.type;
    if (
      deltaType === 'text_delta' ||
      deltaType === 'thinking_delta' ||
      deltaType === 'input_json_delta'
    ) {
      return deltaType;
    }

    return null;
  }

  /**
   * Extract the content block index from a content_block_delta event.
   */
  private getBlockIndex(event: StoredEvent): number | null {
    const data = this.asStreamData(event);
    if (!data?.event || data.event.type !== 'content_block_delta') {
      return null;
    }
    return typeof data.event.index === 'number' ? data.event.index : null;
  }

  /**
   * Extract the text/thinking/json content from a delta.
   */
  private getDeltaContent(event: StoredEvent): string {
    const data = this.asStreamData(event);
    if (!data?.event || data.event.type !== 'content_block_delta' || !data.event.delta) {
      return '';
    }

    const delta = data.event.delta;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return delta.text;
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return delta.thinking;
    }
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      return delta.partial_json;
    }

    return '';
  }

  /**
   * Merge consecutive content_block_delta events of the same type and index.
   */
  private compressConsecutiveDeltas(
    events: StoredEvent[],
    startIndex: number
  ): { compressed: StoredEvent; endIndex: number } {
    const { compressed, endIndex } = this.compressConsecutiveDeltasWithType(events, startIndex);
    return { compressed, endIndex };
  }

  /**
   * Merge consecutive content_block_delta events and return the delta type.
   */
  private compressConsecutiveDeltasWithType(
    events: StoredEvent[],
    startIndex: number
  ): { compressed: StoredEvent; endIndex: number; deltaType: MergeableDeltaType | null } {
    const first = events[startIndex];
    const blockIndex = this.getBlockIndex(first);
    const deltaType = this.getDeltaType(first);

    // If we can't determine type/index, just return as-is
    if (blockIndex === null || deltaType === null) {
      return { compressed: first, endIndex: startIndex, deltaType: null };
    }

    // Accumulate content
    let accumulated = this.getDeltaContent(first);
    let endIndex = startIndex;

    // Look ahead for consecutive matching deltas
    for (let i = startIndex + 1; i < events.length; i++) {
      const event = events[i];

      // Must be a content_block_delta
      if (!this.isContentBlockDelta(event)) {
        break;
      }

      // Must match same index and delta type
      if (this.getBlockIndex(event) !== blockIndex || this.getDeltaType(event) !== deltaType) {
        break;
      }

      accumulated += this.getDeltaContent(event);
      endIndex = i;
    }

    // If no merging happened, return original
    if (endIndex === startIndex) {
      return { compressed: first, endIndex, deltaType };
    }

    // Create merged event
    const compressed = this.createMergedDelta(first, deltaType, accumulated);
    return { compressed, endIndex, deltaType };
  }

  /**
   * Create a new event with merged delta content.
   */
  private createMergedDelta(
    template: StoredEvent,
    deltaType: MergeableDeltaType,
    content: string
  ): StoredEvent {
    const templateData = this.asStreamData(template);
    if (!templateData || templateData.type !== 'stream_event' || !templateData.event) {
      return template;
    }

    const blockIndex = templateData.event.index;
    if (typeof blockIndex !== 'number') {
      return template;
    }

    // Create new delta based on type
    let newDelta: { type: string; text?: string; thinking?: string; partial_json?: string };
    if (deltaType === 'text_delta') {
      newDelta = { type: 'text_delta', text: content };
    } else if (deltaType === 'thinking_delta') {
      newDelta = { type: 'thinking_delta', thinking: content };
    } else {
      newDelta = { type: 'input_json_delta', partial_json: content };
    }

    // Return new event preserving original structure
    return {
      type: 'claude_message',
      data: {
        ...templateData,
        event: {
          type: 'content_block_delta',
          index: blockIndex,
          delta: newDelta,
        },
      },
    };
  }

  /**
   * Deduplicate consecutive identical status events.
   */
  private deduplicateStatusEvents(
    events: StoredEvent[],
    startIndex: number
  ): { deduplicated: StoredEvent; endIndex: number } {
    const first = events[startIndex];
    const runningState = first.running;
    const processAlive = first.processAlive;
    let endIndex = startIndex;

    for (let i = startIndex + 1; i < events.length; i++) {
      const event = events[i];
      if (
        !this.isStatusEvent(event) ||
        event.running !== runningState ||
        event.processAlive !== processAlive
      ) {
        break;
      }
      endIndex = i;
    }

    return { deduplicated: first, endIndex };
  }
}

export const eventCompressionService = new EventCompressionService();
