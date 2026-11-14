import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import type { VirtualItem } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { type ChatMessage, type GroupedMessageItem, isToolSequence } from '@/lib/chat-protocol';
import { getInboxNotification } from './agent-activity/message-renderers/workspace-inbox-notification';

interface Props {
  viewport: HTMLDivElement | null;
  engine: {
    getVirtualItemForOffset(offset: number): Pick<VirtualItem, 'index' | 'end'> | undefined;
  };
  messages: GroupedMessageItem[];
  headerOffset: number;
  queuedMessageIds?: ReadonlySet<string>;
  pendingMessageIds: ReadonlySet<string>;
  enabled: boolean;
  onJump(key: string): void;
}

// The preview is 36px tall with 4px top padding. Leave another 16px before pinning.
const PREVIEW_HEIGHT = 40;
const PIN_CLEARANCE = PREVIEW_HEIGHT + 16;

/** Lives outside the virtualized content so an unmounted prompt remains reachable. */
export function StickyUserMessage({
  viewport,
  engine,
  messages,
  headerOffset,
  queuedMessageIds,
  pendingMessageIds,
  enabled,
  onJump,
}: Props) {
  const prompts = useMemo(
    () =>
      messages.flatMap((item, index) =>
        !isToolSequence(item) &&
        item.source === 'user' &&
        !getInboxNotification(item) &&
        !queuedMessageIds?.has(item.id) &&
        !pendingMessageIds.has(item.id)
          ? [{ message: item, index: index + headerOffset }]
          : []
      ),
    [messages, headerOffset, queuedMessageIds, pendingMessageIds]
  );
  const [message, setMessage] = useState<ChatMessage | null>(null);
  const update = useCallback(() => {
    if (!(enabled && viewport)) {
      setMessage(null);
      return;
    }
    const top = Math.max(0, viewport.scrollTop);
    // Include the overlay area so an approaching prompt hides the old preview
    // before it could cover that prompt. Geometry also works for unmounted rows.
    const leadingRow = engine.getVirtualItemForOffset(top + PREVIEW_HEIGHT);
    const clearedRow = engine.getVirtualItemForOffset(Math.max(0, top - PIN_CLEARANCE));
    const prompt = leadingRow && prompts.findLast((item) => item.index <= leadingRow.index);
    const passed =
      prompt &&
      clearedRow &&
      (prompt.index < clearedRow.index ||
        (prompt.index === clearedRow.index && clearedRow.end <= top - PIN_CLEARANCE));
    setMessage(passed ? prompt.message : null);
  }, [viewport, engine, enabled, prompts]);
  // Recheck after measurements, history prepends, and newly sent messages, too.
  useLayoutEffect(update);
  useLayoutEffect(() => {
    if (!viewport) {
      return;
    }
    viewport.addEventListener('scroll', update, { passive: true });
    return () => viewport.removeEventListener('scroll', update);
  }, [viewport, update]);
  if (!(enabled && message)) {
    return null;
  }
  const preview = message.text?.replace(/\s+/g, ' ').trim() || 'Attached files';
  return (
    <div className="absolute inset-x-0 top-0 z-10 px-4 pt-1">
      <button
        type="button"
        aria-label={`Back to your message: ${preview}`}
        title="Scroll back to your message"
        onClick={() => onJump(message.id)}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-md border bg-background px-3 text-left text-sm shadow-sm hover:bg-accent focus-ring"
      >
        <span className="shrink-0 text-xs font-medium text-muted-foreground">You</span>
        <span className="min-w-0 flex-1 truncate">{preview}</span>
        <ArrowUpIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </div>
  );
}
