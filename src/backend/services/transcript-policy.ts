/**
 * Backend-specific Transcript Inclusion Policy
 *
 * Backend-specific policy functions for ClaudeJson protocol messages.
 * Shared content/message-level policies are in @/shared/transcript-policy.
 *
 * Used by:
 * - Live message forwarding (chat-event-forwarder.service.ts)
 * - JSONL parsing (claude/session.ts)
 */

import {
  shouldIncludeAssistantMessage,
  shouldIncludeStreamEvent,
  shouldIncludeUserMessage,
} from '@/shared/transcript-policy';
import type { ClaudeJson, ClaudeMessage, ClaudeStreamEvent } from '../claude/types';

// Re-export shared policies for convenience
export {
  isSystemContent,
  shouldIncludeAssistantContentItem,
  shouldIncludeAssistantMessage,
  shouldIncludeStreamEvent,
  shouldIncludeUserContentItem,
  shouldIncludeUserMessage,
} from '@/shared/transcript-policy';

// ============================================================================
// Top-Level ClaudeJson Message Type Inclusion Policy (Backend-only)
// ============================================================================

/**
 * Determines if a ClaudeJson message should be included in the transcript.
 * This is backend-specific because it handles the full ClaudeJson protocol.
 *
 * Current policy:
 * - system: Always include (init, status, hooks, compact boundaries)
 * - assistant: Include if has narrative text
 * - user: Include if has non-system content
 * - stream_event: Include only structural events
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
// JSONL Entry Inclusion Policy (Backend-only)
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
