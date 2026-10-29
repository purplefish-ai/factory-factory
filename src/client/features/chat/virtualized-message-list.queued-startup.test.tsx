// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createUserMessage } from '@/lib/claude-fixtures';
import { VirtualizedMessageList } from './virtualized-message-list';

// jsdom has no viewport measurements; expose all rows while keeping rendering real.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 80 })),
    getTotalSize: () => count * 80,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

it.each([null, 'Running init script...'])(
  'keeps queued messages visible and cancellable while loading (%s)',
  (initMessage) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const history = createUserMessage('Earlier conversation', 0);
    const queued = createUserMessage('Please fix the failing tests', 1);
    const onRemove = vi.fn();
    const render = (loadingSession: boolean) => {
      flushSync(() =>
        root.render(
          <VirtualizedMessageList
            messages={[history, queued]}
            queuedMessageIds={new Set([queued.id])}
            onRemoveQueuedMessage={onRemove}
            running={false}
            startingSession
            loadingSession={loadingSession}
            scrollContainerRef={{ current: null }}
            initBanner={
              initMessage
                ? {
                    kind: 'info',
                    message: initMessage,
                    showRetry: false,
                    showPlay: false,
                    showDismiss: false,
                  }
                : null
            }
          />
        )
      );
    };
    try {
      render(true);
      expect(container.textContent).toContain('Please fix the failing tests');
      expect(container.textContent).toContain(initMessage ?? 'Loading session...');
      expect(container.textContent).not.toContain('Earlier conversation');
      expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);
      const cancel = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Cancel queued message"]'
      );
      expect(cancel).not.toBeNull();
      flushSync(() => cancel?.click());
      expect(onRemove).toHaveBeenCalledExactlyOnceWith(queued.id);

      render(false);
      expect(container.textContent).toContain('Earlier conversation');
      expect(container.textContent?.match(/Please fix the failing tests/g)).toHaveLength(1);
    } finally {
      flushSync(() => root.unmount());
    }
  }
);
