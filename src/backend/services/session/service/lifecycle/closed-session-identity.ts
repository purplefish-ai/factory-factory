import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  buildCombinedTextContent,
  buildContentArray,
  categorizeAttachments,
} from '@/backend/services/session/service/chat/chat-message-handlers/attachment-processing';
import type { AgentContentItem, AgentMessage, ChatMessage } from '@/shared/acp-protocol';

export function getClosedSessionConversationEpoch(metadata: unknown): number {
  const parsed = z
    .object({ providerIdentityRollovers: z.array(z.unknown()).optional() })
    .safeParse(metadata);
  return parsed.success ? (parsed.data.providerIdentityRollovers?.length ?? 0) : 0;
}

interface ArchiveIdentityInput {
  sessionId: string;
  workspaceId: string;
  provider: 'CLAUDE' | 'CODEX';
  providerSessionId?: string;
  codexAccountId?: string | null;
  conversationEpoch?: number;
  startedAt: Date;
  messages: ChatMessage[];
}

type ContentToken = { role: 'user' | 'assistant'; content: AgentContentItem };
interface CanonicalContent {
  provider: ContentToken[];
  local: unknown[];
}

function appendContent(
  tokens: ContentToken[],
  role: 'user' | 'assistant',
  content: AgentContentItem
): void {
  const previous = tokens.at(-1);
  // Live accumulation and JSONL chunk splitting must identify the same content.
  // Replace the token, never mutate a block in the original frozen projection.
  if (
    role === 'assistant' &&
    content.type === 'text' &&
    previous?.role === 'assistant' &&
    previous.content.type === 'text'
  ) {
    tokens[tokens.length - 1] = {
      role,
      content: { type: 'text', text: previous.content.text + content.text },
    };
  } else {
    const normalized =
      content.type === 'tool_result'
        ? { ...content, is_error: content.is_error ?? false }
        : content;
    tokens.push({ role, content: normalized });
  }
}

function appendPayload(
  tokens: ContentToken[],
  role: 'user' | 'assistant',
  content: AgentContentItem[] | string
): void {
  const blocks = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
  for (const block of blocks) {
    appendContent(tokens, role, block);
  }
}

function appendUser(tokens: ContentToken[], message: ChatMessage): void {
  const attachments = categorizeAttachments(message.attachments ?? []);
  // Reuse dispatch's pure content builders: native history retains text-file
  // prompt framing and image bytes, not upload IDs or generated image names.
  const content = buildContentArray(
    buildCombinedTextContent(message.text ?? '', attachments.textAttachments),
    attachments.imageAttachments
  );
  if (!content.length) {
    content.push({ type: 'text', text: '' });
  }
  appendPayload(tokens, 'user', content);
}

function appendAgent(tokens: CanonicalContent, agent: AgentMessage): void {
  if (agent.message) {
    appendPayload(tokens.provider, agent.message.role, agent.message.content);
    return;
  }
  if (agent.type === 'stream_event' && agent.event?.type === 'content_block_start') {
    appendContent(tokens.provider, 'assistant', agent.event.content_block);
    return;
  }
  if (agent.type === 'result' && typeof agent.result === 'string' && agent.result) {
    appendContent(tokens.provider, 'assistant', { type: 'text', text: agent.result });
    return;
  }
  if (
    [
      'session_lifecycle',
      'pr_update',
      'child_workspace_update',
      'parent_workspace_update',
    ].includes(agent.type)
  ) {
    const lifecycle = agent.lifecycle;
    tokens.local.push({
      type: agent.type,
      text: agent.text,
      prDeliveryState: agent.prDeliveryState,
      childWorkspaceId: agent.childWorkspaceId,
      parentWorkspaceId: agent.parentWorkspaceId,
      lifecycle: lifecycle
        ? {
            eventId: lifecycle.eventId,
            kind: lifecycle.kind,
            reason: lifecycle.reason,
            message: lifecycle.message,
          }
        : undefined,
    });
  }
  // Runtime-only status/usage envelopes stay in the original archive bytes but
  // are not stable provider-content evidence after a backend restart.
}

function orderedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(orderedValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, orderedValue(entry)])
    );
  }
  return value;
}

function conversationContent(messages: ChatMessage[]) {
  const tokens: CanonicalContent = { provider: [], local: [] };
  for (const message of messages) {
    if (message.providerPrompt != null) {
      appendPayload(tokens.provider, 'user', message.providerPrompt);
    }
    if (message.source === 'user' && message.providerPrompt === undefined) {
      appendUser(tokens.provider, message);
    } else if (message.source === 'agent' && message.message) {
      appendAgent(tokens, message.message);
    }
  }
  // Timestamp-less hydration can move durable local cards relative to provider
  // rows. Preserve their identity/content/multiplicity, not their UI placement.
  return {
    provider: tokens.provider,
    local: tokens.local.map((entry) => JSON.stringify(orderedValue(entry))).sort(),
  };
}

/** Identity is source content and durable conversation scope, never projection clocks/IDs. */
export function getClosedSessionArchiveKey(input: ArchiveIdentityInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        orderedValue({
          version: 'archive-content-v1',
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          provider: input.provider,
          codexAccountId: input.codexAccountId ?? null,
          providerSessionId: input.providerSessionId ?? null,
          conversationEpoch: input.conversationEpoch ?? 0,
          startedAt: input.startedAt.toISOString(),
          content: conversationContent(input.messages),
        })
      )
    )
    .digest('hex');
}
