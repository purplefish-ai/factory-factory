/**
 * Streaming utilities for processing Claude stream events.
 *
 * This module contains helpers for:
 * - Tool input accumulation during streaming
 * - Thinking delta handling (extended thinking mode)
 * - Stream event extraction and validation
 */

import { z } from 'zod';
import type { ClaudeMessage, ClaudeStreamEvent, InputJsonDelta } from '@/lib/claude-types';
import { isStreamEventMessage } from '@/lib/claude-types';
import { createDebugLogger } from '@/lib/debug';
import type { ChatAction } from './chat-reducer';

// =============================================================================
// Debug Logging
// =============================================================================

const DEBUG_STREAMING = false;
const debug = createDebugLogger(DEBUG_STREAMING);

// =============================================================================
// Stream Event Extraction
// =============================================================================

/**
 * Get stream event data from a Claude message.
 * Returns the event if the message is a stream_event type, null otherwise.
 */
function getStreamEvent(claudeMsg: ClaudeMessage): ClaudeStreamEvent | null {
  if (!isStreamEventMessage(claudeMsg)) {
    return null;
  }
  return claudeMsg.event;
}

// =============================================================================
// Tool Input Streaming
// =============================================================================

/**
 * Handle tool_use block start - initialize accumulator.
 */
function handleToolUseStart(
  event: ClaudeStreamEvent,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): void {
  if (event.type !== 'content_block_start') {
    return;
  }
  const block = event.content_block;
  if (block.type === 'tool_use' && block.id) {
    const toolUseId = block.id;
    toolInputAccumulatorRef.current.set(toolUseId, '');
    debug.log('Tool use started:', toolUseId, block.name);
  }
}

/**
 * Handle tool input JSON delta - accumulate and try to parse.
 * Returns a TOOL_INPUT_UPDATE action if valid JSON was accumulated, null otherwise.
 */
function handleToolInputDelta(
  event: ClaudeStreamEvent,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): ChatAction | null {
  if (event.type !== 'content_block_delta') {
    return null;
  }

  // Cast delta to check for input_json_delta
  const delta = event.delta as InputJsonDelta | typeof event.delta;
  if (delta.type !== 'input_json_delta' || !('partial_json' in delta)) {
    return null;
  }

  const accumulatorEntries = Array.from(toolInputAccumulatorRef.current.entries());
  if (accumulatorEntries.length === 0) {
    return null;
  }

  // Get the last (most recent) tool_use_id
  // biome-ignore lint/style/noNonNullAssertion: length > 0 checked above
  const [toolUseId, currentJson] = accumulatorEntries[accumulatorEntries.length - 1]!;
  const newJson = currentJson + delta.partial_json;
  toolInputAccumulatorRef.current.set(toolUseId, newJson);

  // Try to parse the accumulated JSON and create update action
  try {
    const parsed = JSON.parse(newJson);
    const ToolInputSchema = z.record(z.string(), z.unknown());
    const parsedInput = ToolInputSchema.parse(parsed);
    debug.log('Tool input updated:', toolUseId, Object.keys(parsedInput));
    return { type: 'TOOL_INPUT_UPDATE', payload: { toolUseId, input: parsedInput } };
  } catch {
    // JSON not complete yet, that's expected during streaming
    return null;
  }
}

/**
 * Handle tool input accumulation from stream events.
 * Returns a TOOL_INPUT_UPDATE action if input was accumulated, null otherwise.
 */
export function handleToolInputStreaming(
  claudeMsg: ClaudeMessage,
  toolInputAccumulatorRef: React.MutableRefObject<Map<string, string>>
): ChatAction | null {
  const event = getStreamEvent(claudeMsg);
  if (!event) {
    return null;
  }

  // Initialize accumulator for tool_use start events
  handleToolUseStart(event, toolInputAccumulatorRef);

  // Handle input JSON deltas
  return handleToolInputDelta(event, toolInputAccumulatorRef);
}

// =============================================================================
// Thinking Streaming
// =============================================================================

/**
 * Handle thinking delta stream events (extended thinking mode).
 * Returns a THINKING_DELTA action for thinking deltas, THINKING_CLEAR for message_start, null otherwise.
 */
export function handleThinkingStreaming(claudeMsg: ClaudeMessage): ChatAction | null {
  const event = getStreamEvent(claudeMsg);
  if (!event) {
    return null;
  }

  // Clear thinking on new message start
  if (event.type === 'message_start') {
    return { type: 'THINKING_CLEAR' };
  }

  // Accumulate thinking delta
  if (event.type === 'content_block_delta') {
    const delta = event.delta;
    if (delta.type === 'thinking_delta') {
      return { type: 'THINKING_DELTA', payload: { thinking: delta.thinking } };
    }
  }

  return null;
}
