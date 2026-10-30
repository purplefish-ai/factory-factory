// @vitest-environment jsdom
import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
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
afterEach(() => document.body.replaceChildren());

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
  const root = createRoot(host);
  const save = vi.fn();
  flushSync(() =>
    root.render(
      <StrictMode>
        <ChatTranscript
          {...display}
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
  expect(host.textContent).toContain('Loading session...');
  expect(save).not.toHaveBeenCalled();
  flushSync(() => root.unmount());
  expect(save).not.toHaveBeenCalled();
});

it('replaces the viewport at a transcript identity boundary', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
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
  render('B');
  expect(host.querySelector('[data-testid="transcript-viewport"]')).not.toBe(a);
  flushSync(() => root.unmount());
});

it('models the queued PR notice after rows and keeps header/status keys distinct', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
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
  flushSync(() => root.unmount());
});
