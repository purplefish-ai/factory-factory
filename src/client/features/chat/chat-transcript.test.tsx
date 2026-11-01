// @vitest-environment jsdom
import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatTranscript } from './chat-transcript';
import type { TranscriptDisplayProps } from './transcript-display.types';
import { useTranscriptLayout, type TranscriptLayout } from './transcript-layout';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {
      /* Explicit test geometry is zero-size. */
    }
    unobserve() {
      /* No native observer. */
    }
    disconnect() {
      /* No native observer. */
    }
  }
);
const roots = new Set<Root>();
function mountRoot(host: HTMLDivElement) {
  const root = createRoot(host);
  roots.add(root);
  return root;
}
function unmount(root: Root) {
  flushSync(() => root.unmount());
  roots.delete(root);
}
afterEach(() => {
  for (const root of roots) {
    unmount(root);
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const message = {
  id: 'queue',
  source: 'user' as const,
  text: 'Queued prompt',
  order: 1,
  timestamp: '2026-10-30T00:00:00Z',
};
const display: TranscriptDisplayProps = {
  messages: [message],
  running: false,
  startingSession: false,
  loadingSession: true,
};

function LayoutCapture({
  display,
  onLayout,
}: {
  display: TranscriptDisplayProps;
  onLayout: (layout: TranscriptLayout) => void;
}) {
  onLayout(useTranscriptLayout(display, true));
  return null;
}

it('renders only queued prompts during hydration without persisting in StrictMode', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = mountRoot(host);
  const save = vi.fn();
  flushSync(() =>
    root.render(
      <StrictMode>
        <ChatTranscript
          {...display}
          messages={[{ ...message, id: 'history', text: 'Unhydrated history' }, message]}
          contentClassName="mx-auto max-w-4xl"
          queuedMessageIds={new Set(['queue'])}
          scroll={{
            identity: 'A',
            active: true,
            ready: false,
            initialIntent: 'following',
            initialPosition: null,
            onPositionChange: save,
          }}
        />
      </StrictMode>
    )
  );
  expect(host.textContent).toContain('Queued prompt');
  expect(host.textContent).not.toContain('Unhydrated history');
  expect(host.querySelector('.max-w-4xl')?.textContent).toContain('Queued prompt');
  expect(host.textContent).toContain('Loading session...');
  expect(save).not.toHaveBeenCalled();
  unmount(root);
  expect(save).not.toHaveBeenCalled();
});

it('replaces the viewport at a transcript identity boundary', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = mountRoot(host);
  const render = (identity: string) =>
    flushSync(() =>
      root.render(
        <ChatTranscript
          {...display}
          scroll={{
            identity,
            active: true,
            ready: false,
            initialIntent: 'following',
            initialPosition: null,
          }}
        />
      )
    );
  render('A');
  const a = host.querySelector('[data-testid="transcript-viewport"]');
  expect(a).not.toBeNull();
  render('B');
  const b = host.querySelector('[data-testid="transcript-viewport"]');
  expect(b).not.toBeNull();
  expect(b).not.toBe(a);
  unmount(root);
});

it('models the queued PR notice after rows and keeps header/status keys distinct', () => {
  const host = document.createElement('div');
  const root = mountRoot(host);
  let result: TranscriptLayout | undefined;
  const pr = {
    ...message,
    id: 'pr-event-queued',
    message: { type: 'pr_update' as const, content: 'Update' },
  };
  flushSync(() =>
    root.render(
      <LayoutCapture
        display={{
          ...display,
          messages: [message, pr],
          queuedMessageIds: new Set(['queue', 'pr-event-queued']),
        }}
        onLayout={(layout) => {
          result = layout;
        }}
      />
    )
  );
  expect(result?.keys).toEqual(['transcript:header', 'queue']);
  expect(result?.queuedPRUpdate?.id).toBe(pr.id);
  unmount(root);
});

it('keeps the thinking footer outside the viewport and mounted when work stops', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = mountRoot(host);
  const render = (running: boolean, latestThinking: string | null) =>
    flushSync(() =>
      root.render(
        <ChatTranscript
          {...display}
          thinkingInFooter
          loadingSession={false}
          running={running}
          latestThinking={latestThinking}
          scroll={{
            identity: 'footer',
            active: true,
            ready: true,
            initialIntent: 'following',
            initialPosition: null,
          }}
        />
      )
    );
  render(true, 'Checking the implementation');
  const footer = host.querySelector('[data-testid="thinking-footer"]');
  expect(footer).not.toBeNull();
  const viewport = host.querySelector('[data-testid="transcript-viewport"]');
  expect(viewport?.contains(footer)).toBe(false);
  expect(footer?.querySelector('button')?.disabled).toBe(false);
  render(false, null);
  expect(host.querySelector('[data-testid="thinking-footer"]')).toBe(footer);
  expect(footer?.querySelector('button')?.disabled).toBe(true);
});

it.each([
  { running: true, promptInFlight: true, turn: false, active: true },
  { running: true, promptInFlight: false, turn: false, active: false },
  { running: false, promptInFlight: false, turn: true, active: true },
])(
  'reflects prompt ownership and autonomous turns in the footer: %j',
  ({ running, promptInFlight, turn, active }) => {
    const host = document.createElement('div');
    const root = mountRoot(host);
    flushSync(() =>
      root.render(
        <ChatTranscript
          {...display}
          loadingSession={false}
          thinkingInFooter
          running={running}
          work={{
            promptInFlight,
            backgroundTasks: turn ? [{ id: 'turn', name: 'Working', kind: 'turn' }] : [],
            runningSubagents: 0,
            activeGoals: 0,
          }}
          scroll={{
            identity: 'work',
            active: true,
            ready: true,
            initialIntent: 'following',
            initialPosition: null,
          }}
        />
      )
    );
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="thinking-footer"] button')?.disabled
    ).toBe(!active);
  }
);

it.each([
  { contentHeight: 200, showsButton: false },
  { contentHeight: 600, showsButton: true },
])(
  'shows scroll to bottom only with content below the viewport: %j',
  ({ contentHeight, showsButton }) => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(contentHeight);
    const host = document.createElement('div');
    document.body.append(host);
    const root = mountRoot(host);
    flushSync(() =>
      root.render(
        <ChatTranscript
          {...display}
          loadingSession={false}
          scroll={{
            identity: 'short-reading',
            active: true,
            ready: true,
            initialIntent: 'reading',
            initialPosition: null,
          }}
        />
      )
    );
    const viewport = host.querySelector<HTMLElement>('[data-testid="transcript-viewport"]');
    expect(viewport?.clientHeight).toBe(400);
    expect(viewport?.scrollHeight).toBe(contentHeight);
    expect(host.textContent?.includes('Scroll to bottom')).toBe(showsButton);
  }
);
