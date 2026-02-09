/**
 * Streaming utilities for processing Claude stream events.
 *
 * This module contains helpers for:
 * - Tool input accumulation during streaming
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

export interface ToolInputAccumulatorState {
  toolUseIdByIndex: Map<number, string>;
  inputJsonByToolUseId: Map<string, string>;
}

export function createToolInputAccumulatorState(): ToolInputAccumulatorState {
  return {
    toolUseIdByIndex: new Map(),
    inputJsonByToolUseId: new Map(),
  };
}

export function clearToolInputAccumulator(state: ToolInputAccumulatorState): void {
  state.toolUseIdByIndex.clear();
  state.inputJsonByToolUseId.clear();
}

/**
 * Handle tool_use block start - initialize accumulator.
 */
function handleToolUseStart(
  event: ClaudeStreamEvent,
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>
): void {
  if (event.type !== 'content_block_start') {
    return;
  }
  const block = event.content_block;
  if (block.type === 'tool_use' && block.id) {
    const toolUseId = block.id;
    toolInputAccumulatorRef.current.toolUseIdByIndex.set(event.index, toolUseId);
    toolInputAccumulatorRef.current.inputJsonByToolUseId.set(toolUseId, '');
    debug.log('Tool use started:', toolUseId, block.name);
  }
}

/**
 * Handle tool input JSON delta - accumulate and try to parse.
 * Returns a TOOL_INPUT_UPDATE action if valid JSON was accumulated, null otherwise.
 */
function handleToolInputDelta(
  event: ClaudeStreamEvent,
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>
): ChatAction | null {
  if (event.type !== 'content_block_delta') {
    return null;
  }

  // Cast delta to check for input_json_delta
  const delta = event.delta as InputJsonDelta | typeof event.delta;
  if (delta.type !== 'input_json_delta' || !('partial_json' in delta)) {
    return null;
  }

  const toolUseId = toolInputAccumulatorRef.current.toolUseIdByIndex.get(event.index);
  if (!toolUseId) {
    return null;
  }

  const currentJson = toolInputAccumulatorRef.current.inputJsonByToolUseId.get(toolUseId) ?? '';
  const newJson = currentJson + delta.partial_json;
  toolInputAccumulatorRef.current.inputJsonByToolUseId.set(toolUseId, newJson);

  // Try to parse the accumulated JSON and create update action
  try {
    const parsed = JSON.parse(newJson);
    const ToolInputSchema = z.record(z.string(), z.unknown());
    const parsedInput = ToolInputSchema.parse(parsed);
    debug.log('Tool input updated:', toolUseId, Object.keys(parsedInput));
    return { type: 'TOOL_INPUT_UPDATE', payload: { toolUseId, input: parsedInput } };
  } catch {
    // JSON incomplete/invalid - expected during streaming or if structure is wrong
    return null;
  }
}

function handleToolUseStop(
  event: ClaudeStreamEvent,
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>
): void {
  if (event.type !== 'content_block_stop') {
    return;
  }

  const toolUseId = toolInputAccumulatorRef.current.toolUseIdByIndex.get(event.index);
  if (!toolUseId) {
    return;
  }
  toolInputAccumulatorRef.current.toolUseIdByIndex.delete(event.index);
  toolInputAccumulatorRef.current.inputJsonByToolUseId.delete(toolUseId);
}

/**
 * Handle tool input accumulation from stream events.
 * Returns a TOOL_INPUT_UPDATE action if input was accumulated, null otherwise.
 */
export function handleToolInputStreaming(
  claudeMsg: ClaudeMessage,
  toolInputAccumulatorRef: React.MutableRefObject<ToolInputAccumulatorState>
): ChatAction | null {
  const event = getStreamEvent(claudeMsg);
  if (!event) {
    return null;
  }

  // Initialize accumulator for tool_use start events
  handleToolUseStart(event, toolInputAccumulatorRef);

  // Release per-tool buffers when tool_use streaming completes.
  handleToolUseStop(event, toolInputAccumulatorRef);

  // Handle input JSON deltas
  return handleToolInputDelta(event, toolInputAccumulatorRef);
}
