// @vitest-environment jsdom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { TranscriptDisplayProps } from './transcript-display.types';
import { TranscriptRenderingFixture } from './transcript-rendering.test-utils';

function createHarness(
  overrides: Pick<TranscriptDisplayProps, 'subagentTimelineError' | 'acpPlan'>
) {
  const container = document.createElement('div');
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <TranscriptRenderingFixture
        messages={[]}
        running={false}
        startingSession={false}
        loadingSession={false}
        {...overrides}
      />
    )
  );
  return { container, cleanup: () => flushSync(() => root.unmount()) };
}

it('keeps a sub-agent timeline load error visible and offers retry without messages', () => {
  const onRetry = vi.fn();
  const message = 'Some sub-agent activity could not be loaded.';
  const harness = createHarness({ subagentTimelineError: { message, onRetry } });
  try {
    expect(harness.container.querySelector('[role="status"]')?.textContent).toContain(message);
    expect(harness.container.textContent).not.toContain('Ready to start');
    const retry = Array.from(harness.container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry'
    );
    expect(retry).toBeDefined();
    flushSync(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();
  } finally {
    harness.cleanup();
  }
});

it('keeps inline tasks visible alongside sub-agent history recovery', () => {
  const message = 'Some sub-agent activity could not be loaded.';
  const harness = createHarness({
    acpPlan: {
      entries: [{ content: 'Verify recovery', status: 'in_progress', priority: 'high' }],
      updatedAt: '2026-10-30T12:00:00Z',
    },
    subagentTimelineError: { message, onRetry: vi.fn() },
  });
  try {
    expect(harness.container.textContent).toContain(message);
    expect(harness.container.querySelector('[aria-label="Tasks"]')?.textContent).toContain(
      'Verify recovery'
    );
    const status = harness.container.querySelector('[role="status"]');
    const tasks = harness.container.querySelector('[aria-label="Tasks"]');
    expect(status?.nextElementSibling).toBe(tasks);
  } finally {
    harness.cleanup();
  }
});
