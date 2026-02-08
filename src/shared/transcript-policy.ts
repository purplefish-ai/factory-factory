/**
 * Transcript Inclusion Policy
 *
 * Centralized policy for determining which messages and events should be included
 * in session transcripts. Used by:
 * - Live message forwarding (backend: chat-event-forwarder.service.ts)
 * - Client-side message filtering (client: components/chat/reducer/helpers.ts)
 * - JSONL parsing (backend: claude/session.ts)
 *
 * Design principle: Include everything by default. Filtering should be explicit
 * and rare, applied only to truly transient/internal events.
 */

import type { ClaudeContentItem, ClaudeMessagePayload, ClaudeStreamEvent } from './claude/protocol';

// ============================================================================
// Content-Level Inclusion Policy
// ============================================================================

/**
 * Checks if a text content item is system/meta content that shouldn't be in transcripts.
 * System content includes:
 * - System instructions injected by Conductor (<system_instruction>)
 * - Local command output (<local-command>)
 */
export function isSystemContent(text: string): boolean {
  return text.startsWith('<system_instruction>') || text.startsWith('<local-command');
}

/**
 * Determines if a user content item should be included in the transcript.
 * Includes:
 * - Regular text (unless it's system content)
 * - Tool results
 * - Images
 *
 * Excludes:
 * - System instructions
 * - system_instruction items (explicit type)
 */
export function shouldIncludeUserContentItem(item: ClaudeContentItem): boolean {
  if (item.type === 'text') {
    return !isSystemContent(item.text);
  }
  if (item.type === 'tool_result') {
    return true;
  }
  if (item.type === 'image') {
    return true;
  }
  // Exclude system_instruction items
  return false;
}

/**
 * Determines if an assistant content item should be included in the transcript.
 * Includes:
 * - Text blocks (narrative content)
 * - Tool use blocks
 * - Thinking blocks
 */
export function shouldIncludeAssistantContentItem(item: ClaudeContentItem): boolean {
  return item.type === 'text' || item.type === 'tool_use' || item.type === 'thinking';
}

// ============================================================================
// Message-Level Inclusion Policy
// ============================================================================

/**
 * Determines if a user message should be included in the transcript.
 *
 * Current policy:
 * - String content: Exclude (user text input is not stored separately)
 * - Array content: Include only if has tool_result items
 *
 * Rationale: User messages are already captured as part of the conversation
 * flow. We only store user messages that contain tool results, which represent
 * the outcomes of tool executions that need to be preserved.
 */
export function shouldIncludeUserMessage(message: ClaudeMessagePayload): boolean {
  const { content } = message;

  // String content is not stored (user text is implicit in conversation flow)
  if (typeof content === 'string') {
    return false;
  }

  // Array content: only store if it contains tool results
  if (Array.isArray(content)) {
    return content.some((item) => item.type === 'tool_result');
  }

  return false;
}

/**
 * Determines if an assistant message should be included in the transcript.
 *
 * Current policy:
 * - String content: Always include
 * - Array content: Include if has at least one text/tool_use/thinking block
 *
 * Note: Pure tool-use-only messages (no narrative text) are currently excluded
 * to reduce UI noise, but this is configurable.
 */
export function shouldIncludeAssistantMessage(message: ClaudeMessagePayload): boolean {
  const { content } = message;

  if (typeof content === 'string') {
    return true;
  }

  if (Array.isArray(content)) {
    // Include if has any narrative text blocks
    // This excludes pure tool-use-only messages
    return content.some((item) => item.type === 'text');
  }

  return false;
}

// ============================================================================
// Stream Event-Level Inclusion Policy
// ============================================================================

/**
 * Determines if a stream event should be included in the transcript.
 *
 * Current policy (focused on structural events):
 * - content_block_start: Include for tool_use, tool_result, and thinking
 * - All other stream events: Exclude (deltas, stops, etc.)
 *
 * Rationale: Stream events are transient. We store the final messages,
 * so most stream events are redundant for transcript purposes.
 */
export function shouldIncludeStreamEvent(event: ClaudeStreamEvent): boolean {
  if (event.type === 'content_block_start') {
    const blockType = event.content_block.type;
    return blockType === 'tool_use' || blockType === 'tool_result' || blockType === 'thinking';
  }

  // Exclude: content_block_delta, content_block_stop, message_start,
  // message_delta, message_stop
  return false;
}
