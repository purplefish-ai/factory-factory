import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp';
import type { VirtualItem } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useState } from 'react';
import { type GroupedMessageItem, isToolSequence } from '@/lib/chat-protocol';

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
  const index = messages.findLastIndex(
    (item) =>
      !isToolSequence(item) &&
      item.source === 'user' &&
      !queuedMessageIds?.has(item.id) &&
      !pendingMessageIds.has(item.id)
  );
  const message = messages[index];
  const [passed, setPassed] = useState(false);
  const update = useCallback(() => {
    const row = viewport && engine.getVirtualItemForOffset(Math.max(0, viewport.scrollTop));
    setPassed(
      Boolean(
        enabled &&
        message &&
        row &&
        (row.index > index + headerOffset ||
          (row.index === index + headerOffset && row.end <= (viewport?.scrollTop ?? 0)))
      )
    );
  }, [viewport, engine, enabled, message, index, headerOffset]);
  // Recheck after measurements, history prepends, and newly sent messages, too.
  useLayoutEffect(update);
  useLayoutEffect(() => {
    if (!viewport) {
      return;
    }
    viewport.addEventListener('scroll', update, { passive: true });
    return () => viewport.removeEventListener('scroll', update);
  }, [viewport, update]);
  if (!(enabled && passed && message) || isToolSequence(message)) {
    return null;
  }
  const preview = message.text?.replace(/\s+/g, ' ').trim() || 'Attached files';
  return (
    <div className="absolute inset-x-0 top-0 z-10 px-4 pt-1">
      <button
        type="button"
        aria-label={`Back to your latest message: ${preview}`}
        title="Scroll back to your latest message"
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
