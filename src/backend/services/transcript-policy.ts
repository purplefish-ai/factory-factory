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

  // Skip entries without a message payload (null or undefined)
  if (entry.message == null) {
    return false;
  }

  return true;
}
