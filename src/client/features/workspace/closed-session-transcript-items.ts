import type { z } from 'zod';
import { withOccurrenceKeys } from '@/client/lib/list-keys';
import {
  type ChatMessage,
  type GroupedMessageItem,
  groupAdjacentToolCalls,
  isToolResultContent,
  isToolSequence,
  type PairedToolCall,
  type ToolResultContent,
  type ToolSequence,
} from '@/lib/chat-protocol';
import type { ArchivedJsonValueSchema } from '@/shared/acp-protocol/protocol/archived-content-schema';
import { ArchivedChatMessageSchema } from '@/shared/acp-protocol/protocol/archived-message-schema';

type ArchivedJsonValue = z.infer<typeof ArchivedJsonValueSchema>;
type ClosedSessionTranscriptItem =
  | { kind: 'rich'; value: GroupedMessageItem }
  | { kind: 'fallback'; value: ArchivedJsonValue; sourceIndex: number };

function requireTraceValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Missing archive grouping trace value');
  }
  return value;
}

function resultBlocks(row: ChatMessage): ToolResultContent[] {
  const content = row.message?.message?.content;
  const event = row.message?.event;
  return [
    ...(Array.isArray(content) ? content.filter(isToolResultContent) : []),
    ...(event?.type === 'content_block_start' && isToolResultContent(event.content_block)
      ? [event.content_block]
      : []),
    ...(event?.type === 'message_start' && Array.isArray(event.message.content)
      ? event.message.content.filter(isToolResultContent)
      : []),
  ];
}

/** Passive projection: raw JSON stays untouched; only full-codec output enters grouping. */
export function projectClosedSessionTranscriptRows(
  rows: readonly ArchivedJsonValue[]
): { key: string; item: ClosedSessionTranscriptItem }[] {
  const buckets: ClosedSessionTranscriptItem[][] = rows.map(() => []);
  const indices = new Map<ChatMessage, number>();
  let run: ChatMessage[] = [];
  const add = (index: number | undefined, item: ClosedSessionTranscriptItem) =>
    requireTraceValue(buckets[requireTraceValue(index)]).push(item);

  const flush = () => {
    if (run.length === 0) {
      return;
    }
    const callRows = new Map<PairedToolCall, ChatMessage>();
    const sequenceRows = new Map<ToolSequence, readonly ChatMessage[]>();
    const consumed = new Map<ChatMessage, Set<ToolResultContent>>();
    const grouped = groupAdjacentToolCalls(run, {
      onToolCall: (message, call) => callRows.set(call, message),
      onToolResult: (message, block) => {
        const blocks = consumed.get(message) ?? new Set<ToolResultContent>();
        blocks.add(block);
        consumed.set(message, blocks);
      },
      onToolSequence: (sequence, messages) => sequenceRows.set(sequence, messages),
    });
    const orphans = new Set<ChatMessage>();
    const segments = new Map<ChatMessage, number>();
    let segment = 0;
    for (const message of run) {
      segments.set(message, segment);
      // Inventory every occurrence, including those the grouper never selects.
      if (resultBlocks(message).some((block) => !consumed.get(message)?.has(block))) {
        orphans.add(message);
        segment += 1;
      }
    }
    const addSequence = (item: ToolSequence) => {
      // Trace supplies identities from the actual pairing authority, never ID guesses.
      const source = requireTraceValue(sequenceRows.get(item));
      const first = requireTraceValue(source[0]);
      const last = requireTraceValue(source.at(-1));
      if (segments.get(first) === segments.get(last) && !orphans.has(last)) {
        add(indices.get(first), { kind: 'rich', value: item });
        return;
      }
      let part: ToolSequence | undefined;
      let previousSegment: number | undefined;
      for (const call of item.pairedCalls) {
        const message = requireTraceValue(callRows.get(call));
        const currentSegment = requireTraceValue(segments.get(message));
        if (!part || previousSegment !== currentSegment) {
          const index = requireTraceValue(indices.get(message));
          part = { type: 'tool_sequence', id: `${item.id}:archive:${index}`, pairedCalls: [] };
          add(index, { kind: 'rich', value: part });
          previousSegment = currentSegment;
        }
        // Preserve the actual paired objects, including results assigned after a flush.
        part.pairedCalls.push(call);
      }
    };
    for (const item of grouped) {
      if (isToolSequence(item)) {
        addSequence(item);
      } else {
        add(indices.get(item), { kind: 'rich', value: item });
      }
    }
    // Rich items precede raw inspection at a same-index tie. Paired fields may repeat.
    for (const message of orphans) {
      const sourceIndex = requireTraceValue(indices.get(message));
      add(sourceIndex, {
        kind: 'fallback',
        value: requireTraceValue(rows[sourceIndex]),
        sourceIndex,
      });
    }
    run = [];
  };

  rows.forEach((value, sourceIndex) => {
    // Parse each ARRAY OCCURRENCE: repeated raw references must not share parsed identity.
    const parsed = ArchivedChatMessageSchema.safeParse(value);
    if (parsed.success) {
      indices.set(parsed.data, sourceIndex);
      run.push(parsed.data);
    } else {
      flush();
      add(sourceIndex, { kind: 'fallback', value, sourceIndex });
    }
  });
  flush();
  return withOccurrenceKeys(buckets.flat(), (item) =>
    item.kind === 'rich' ? item.value.id : `fallback-${item.sourceIndex}`
  );
}
