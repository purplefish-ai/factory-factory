// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextRenderer } from './stream-event-renderer';
import { StreamingTextProvider } from './streaming-text-context';
import {
  STREAMING_TEXT_INTERVAL_MS,
  useStreamingTextSnapshot,
} from './use-streaming-text-snapshot';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const renders: string[] = [];

function Probe({ text, streaming }: { text: string; streaming: boolean }) {
  const snapshot = useStreamingTextSnapshot(text, streaming);
  renders.push(snapshot);
  return createElement('span', null, snapshot);
}

describe('useStreamingTextSnapshot', () => {
  const render = (text: string, streaming: boolean) =>
    act(() => root.render(createElement(Probe, { text, streaming })));
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  beforeEach(() => {
    renders.length = 0;
  });

  it('returns text immediately when not streaming', async () => {
    await render('a', false);
    await render('ab', false);
    expect(container.textContent).toBe('ab');
  });

  it('throttles 25 ms deltas and converges to the final text', async () => {
    let text = 'x';
    await render(text, true);
    for (let delta = 0; delta < 40; delta++) {
      text += 'y';
      await render(text, true);
      await advance(25);
    }
    // 40 deltas over one second commit roughly ten snapshots, not forty.
    const distinctSnapshots = new Set(renders).size;
    expect(distinctSnapshots).toBeGreaterThan(5);
    expect(distinctSnapshots).toBeLessThanOrEqual(1000 / STREAMING_TEXT_INTERVAL_MS + 2);

    text += ' final';
    await render(text, true);
    expect(container.textContent).not.toBe(text);
    await advance(STREAMING_TEXT_INTERVAL_MS);
    expect(container.textContent).toBe(text);
  });

  it('renders the final text without waiting when streaming ends', async () => {
    await render('start', true);
    await advance(STREAMING_TEXT_INTERVAL_MS);
    await render('start and more', true);
    expect(container.textContent).toBe('start');
    await render('start and more, done', false);
    expect(container.textContent).toBe('start and more, done');
  });

  it('starts a later streaming phase from the current text', async () => {
    await render('first', false);
    await render('first reply', false);
    await render('first reply', true);
    expect(container.textContent).toBe('first reply');
  });
});

describe('TextRenderer streaming', () => {
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const render = (text: string, streamingMessageId: string | null) =>
    act(() =>
      root.render(
        <StreamingTextProvider streamingMessageId={streamingMessageId}>
          <TextRenderer text={text} messageId="message-1" />
        </StreamingTextProvider>
      )
    );

  it('uses Streamdown word fades for the live reply and settles immediately', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    try {
      await render('**Live reply', 'message-1');
      expect(container.querySelector('strong')?.textContent).toBe('Live reply');
      expect(container.querySelector('[data-sd-animate]')).not.toBeNull();
      await render('**Live reply**', null);
      expect(container.querySelector('strong')?.textContent).toBe('Live reply');
      expect(container.querySelector('[data-sd-animate]')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('converges to the final Markdown for the streaming message', async () => {
    await render('# Title\n\nFirst', 'message-1');
    await render('# Title\n\nFirst paragraph', 'message-1');
    expect(container.querySelector('p')?.textContent).toBe('First');

    await advance(STREAMING_TEXT_INTERVAL_MS);
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('p')?.textContent).toBe('First paragraph');

    await render('# Title\n\nFirst paragraph\n\nDone.', null);
    expect(Array.from(container.querySelectorAll('p'), (p) => p.textContent)).toEqual([
      'First paragraph',
      'Done.',
    ]);
  });

  it('renders other messages without throttling', async () => {
    await render('Old', 'another-message');
    await render('Old reply', 'another-message');
    expect(container.textContent).toBe('Old reply');
  });
});
