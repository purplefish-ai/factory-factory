// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { VirtualizedMessageList } from './virtualized-message-list';

describe('VirtualizedMessageList loading status', () => {
  it('shows one workspace setup spinner, then session loading after setup finishes', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (initBanner: WorkspaceInitBanner | null) => {
      flushSync(() => {
        root.render(
          <VirtualizedMessageList
            messages={[]}
            running={false}
            startingSession={false}
            loadingSession
            scrollContainerRef={{ current: null }}
            initBanner={initBanner}
          />
        );
      });
    };

    try {
      render({
        kind: 'info',
        message: 'Creating worktree...',
        showRetry: false,
        showPlay: false,
        showDismiss: false,
      });
      expect(container.textContent).toBe('Creating worktree...');
      expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);

      render(null);
      expect(container.textContent).toBe('Loading session...');
      expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);
    } finally {
      root.unmount();
    }
  });
});
