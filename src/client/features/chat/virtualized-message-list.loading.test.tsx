// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { VirtualizedMessageList } from './virtualized-message-list';

describe('VirtualizedMessageList loading status', () => {
  it('identifies background processes after the prompt finishes and removes completed work', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const work = {
      promptInFlight: false,
      backgroundTasks: [
        { id: 'storybook', name: 'pnpm storybook --port 62770', kind: 'shell' as const },
      ],
      runningSubagents: 0,
      activeGoals: 0,
    };
    const render = (
      running: boolean,
      promptInFlight: boolean,
      backgroundTasks = work.backgroundTasks
    ) => {
      flushSync(() => {
        root.render(
          <VirtualizedMessageList
            messages={[]}
            running={running}
            work={{ ...work, promptInFlight, backgroundTasks }}
            latestThinking="Old reasoning from the finished turn"
            startingSession={false}
            loadingSession={false}
            scrollContainerRef={{ current: null }}
          />
        );
      });
    };
    try {
      render(true, false);
      expect(container.textContent).toContain('Background process running');
      expect(container.textContent).toContain('pnpm storybook --port 62770');
      expect(container.textContent).not.toContain('Old reasoning');
      expect(container.textContent).not.toContain('Agent is working');
      expect(container.querySelectorAll('.animate-spin')).toHaveLength(0);
      render(true, true);
      expect(container.textContent).toContain('Old reasoning');
      expect(container.textContent).toContain('pnpm storybook --port 62770');
      render(true, true, []);
      expect(container.textContent).toContain('Old reasoning');
      expect(container.textContent).not.toContain('pnpm storybook');
      render(false, false, []);
      expect(container.querySelector('[aria-label="Session activity"]')).toBeNull();
    } finally {
      root.unmount();
    }
  });

  it('shows remaining processes after a failed turn without claiming the agent is working', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      flushSync(() =>
        root.render(
          <VirtualizedMessageList
            messages={[]}
            running={false}
            startingSession={false}
            loadingSession={false}
            scrollContainerRef={{ current: null }}
            work={{
              promptInFlight: false,
              backgroundTasks: [{ id: 'preview', name: 'pnpm storybook', kind: 'shell' }],
              runningSubagents: 0,
              activeGoals: 0,
            }}
          />
        )
      );
      expect(container.textContent).toContain('pnpm storybook');
      expect(container.textContent).not.toContain('Agent is working');
      expect(container.querySelector('.animate-spin')).toBeNull();
    } finally {
      root.unmount();
    }
  });

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
