// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { TranscriptRenderingFixture } from './transcript-rendering.test-harness';

it.each(['subagents', 'processes'])(
  'remembers %s expansion across navigation and isolates sessions',
  (section) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (sessionId: string) =>
      flushSync(() =>
        root.render(
          <TranscriptRenderingFixture
            sessionId={sessionId}
            workspaceId="activity-workspace"
            messages={[]}
            running={false}
            startingSession={false}
            loadingSession={false}
            work={{
              promptInFlight: false,
              backgroundTasks:
                section === 'processes' ? [{ id: 'tests', name: 'pnpm test', kind: 'shell' }] : [],
              runningSubagents: section === 'subagents' ? 2 : 0,
              activeGoals: 0,
            }}
            runningSubagentList={<p>Review code</p>}
          />
        )
      );
    const expanded = () =>
      host.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded');
    try {
      render(`remember-${section}`);
      expect(expanded()).toBe('false');
      flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click());
      expect(expanded()).toBe('true');
      flushSync(() => root.render(null));
      render(`remember-${section}`);
      expect(expanded()).toBe('true');
      render(`other-${section}`);
      expect(expanded()).toBe('false');
      render(`remember-${section}`);
      expect(expanded()).toBe('true');
      flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click());
      flushSync(() => root.render(null));
      render(`remember-${section}`);
      expect(expanded()).toBe('false');
    } finally {
      flushSync(() => root.unmount());
    }
  }
);
