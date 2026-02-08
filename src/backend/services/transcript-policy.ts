/**
 * Transcript Inclusion Policy
 *
 * Centralized policy for determining which messages and events should be included
 * in session transcripts. Used by:
 * - Live message forwarding (chat-event-forwarder.service.ts)
 * - JSONL parsing (claude/session.ts)
 * - Client-side message filtering (components/chat/reducer/helpers.ts)
 *
 * Design principle: Include everything by default. Filtering should be explicit
 * and rare, applied only to truly transient/internal events.
 */

import type {
  ClaudeContentItem,
  ClaudeJson,
  ClaudeMessage,
  ClaudeStreamEvent,
} from '../claude/types';

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
 * - String content: Include if not system content
 * - Array content: Include if has at least one non-system item
 * - Tool results: Always include
 */
export function shouldIncludeUserMessage(message: ClaudeMessage): boolean {
  const { content } = message;

  if (typeof content === 'string') {
    return !isSystemContent(content);
  }

  if (Array.isArray(content)) {
    return content.some((item) => shouldIncludeUserContentItem(item));
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
export function shouldIncludeAssistantMessage(message: ClaudeMessage): boolean {
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

// ============================================================================
// Top-Level Message Type Inclusion Policy
// ============================================================================

/**
 * Determines if a ClaudeJson message should be included in the transcript.
 *
 * Current policy:
 * - system: Always include (init, status, hooks, compact boundaries)
 * - assistant: Include if has narrative text (see shouldIncludeAssistantMessage)
 * - user: Include if has non-system content (see shouldIncludeUserMessage)
 * - stream_event: Include only structural events (see shouldIncludeStreamEvent)
 * - result: Always include
 * - tool_progress: Always include
 * - tool_use_summary: Always include
 * - control_request: Exclude (internal protocol)
 * - control_response: Exclude (internal protocol)
 * - control_cancel_request: Exclude (internal protocol)
 * - keep_alive: Exclude (internal protocol)
 */
export function shouldIncludeInTranscript(claudeMsg: ClaudeJson): {
  include: boolean;
  reason?: string;
} {
  switch (claudeMsg.type) {
    case 'system':
      return { include: true };

    case 'assistant': {
      const msg = claudeMsg as { message: ClaudeMessage };
      const include = shouldIncludeAssistantMessage(msg.message);
      return {
        include,
        reason: include ? undefined : 'assistant_no_text_content',
      };
    }

    case 'user': {
      const msg = claudeMsg as { message: ClaudeMessage };
      const include = shouldIncludeUserMessage(msg.message);
      return {
        include,
        reason: include ? undefined : 'user_no_non_system_content',
      };
    }

    case 'stream_event': {
      const msg = claudeMsg as { event: ClaudeStreamEvent };
      const include = shouldIncludeStreamEvent(msg.event);
      return {
        include,
        reason: include ? undefined : 'stream_event_transient',
      };
    }

    case 'result':
      return { include: true };

    case 'tool_progress':
      return { include: true };

    case 'tool_use_summary':
      return { include: true };

    case 'control_request':
      return { include: false, reason: 'control_protocol_internal' };

    case 'control_response':
      return { include: false, reason: 'control_protocol_internal' };

    case 'control_cancel_request':
      return { include: false, reason: 'control_protocol_internal' };

    case 'keep_alive':
      return { include: false, reason: 'keep_alive_internal' };

    default:
      // Unknown type - include by default (defensive)
      return { include: true };
  }
}

// ============================================================================
// JSONL Entry Inclusion Policy
// ============================================================================

/**
 * Determines if a JSONL entry should be included when loading history.
 * This is used during cold-start session hydration from JSONL files.
 *
 * Excludes:
 * - Meta messages (isMeta: true)
 * - Messages without a message payload
 */
export function shouldIncludeJSONLEntry(entry: Record<string, unknown>): boolean {
  // Skip meta messages
  if (entry.isMeta === true) {
    return false;
  }

  // Skip entries without a message payload
  if (!entry.message) {
    return false;
  }

  return true;
}
