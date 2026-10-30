// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { WorkspaceInitBanner } from '@/shared/workspace-init';
import { TranscriptRenderingFixture } from './transcript-rendering.test-utils';

describe('TranscriptRenderingFixture loading status', () => {
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
          <TranscriptRenderingFixture
            messages={[]}
            running={running}
            work={{ ...work, promptInFlight, backgroundTasks }}
            latestThinking="Old reasoning from the finished turn"
            startingSession={false}
            loadingSession={false}
          />
        );
      });
    };
    try {
      render(true, false);
      expect(container.textContent).toContain('Background process running');
      expect(container.textContent).not.toContain('pnpm storybook --port 62770');
      expect(container.textContent).not.toContain('Old reasoning');
      expect(container.textContent).not.toContain('Agent is working');
      expect(container.querySelectorAll('.animate-spin')).toHaveLength(0);
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
      expect(trigger?.getAttribute('aria-expanded')).toBe('false');
      flushSync(() => trigger?.click());
      expect(trigger?.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('pnpm storybook --port 62770');
      flushSync(() => trigger?.click());
      expect(trigger?.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('pnpm storybook --port 62770');
      flushSync(() => trigger?.click());
      render(true, true);
      expect(container.textContent).toContain('Old reasoning');
      expect(container.textContent).toContain('pnpm storybook --port 62770');
      render(true, true, []);
      expect(container.textContent).toContain('Old reasoning');
      expect(container.textContent).not.toContain('pnpm storybook');
      render(false, false, []);
      expect(container.querySelector('[role="status"]')).toBeNull();
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
          <TranscriptRenderingFixture
            messages={[]}
            running={false}
            startingSession={false}
            loadingSession={false}
            work={{
              promptInFlight: false,
              backgroundTasks: [{ id: 'preview', name: 'pnpm storybook', kind: 'shell' }],
              runningSubagents: 0,
              activeGoals: 0,
            }}
          />
        )
      );
      expect(container.textContent).toContain('Background process running');
      expect(container.textContent).not.toContain('pnpm storybook');
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
      flushSync(() => trigger?.click());
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
          <TranscriptRenderingFixture
            messages={[]}
            running={false}
            startingSession={false}
            loadingSession
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
