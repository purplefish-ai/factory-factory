// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextRenderer } from './stream-event-renderer';
import { StreamingTextProvider } from './streaming-text-context';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('TextRenderer streaming', () => {
  const render = (text: string, streamingMessageId: string | null) =>
    act(() =>
      root.render(
        <StreamingTextProvider streamingMessageId={streamingMessageId}>
          <TextRenderer text={text} messageId="message-1" />
        </StreamingTextProvider>
      )
    );

  it('uses Streamdown word fades for the live reply and settles immediately', async () => {
    await render('**Live reply', 'message-1');
    expect(container.querySelector('strong')?.textContent).toBe('Live reply');
    expect(container.querySelector('[data-sd-animate]')).not.toBeNull();
    await render('**Live reply**', null);
    expect(container.querySelector('strong')?.textContent).toBe('Live reply');
    expect(container.querySelector('[data-sd-animate]')).toBeNull();
  });

  it('renders each streamed update of the live reply without its own throttle', async () => {
    // The chat state's stream-delta coalescer paces these updates, so the
    // renderer must not add a second delay on top of its window.
    await render('# Title\n\nFirst', 'message-1');
    await render('# Title\n\nFirst paragraph', 'message-1');
    expect(container.querySelector('h1')?.textContent).toBe('Title');
    expect(container.querySelector('p')?.textContent).toBe('First paragraph');

    await render('# Title\n\nFirst paragraph\n\nDone.', null);
    expect(Array.from(container.querySelectorAll('p'), (p) => p.textContent)).toEqual([
      'First paragraph',
      'Done.',
    ]);
  });

  it('renders other messages without word fades', async () => {
    await render('Old', 'another-message');
    await render('Old reply', 'another-message');
    expect(container.textContent).toBe('Old reply');
    expect(container.querySelector('[data-sd-animate]')).toBeNull();
  });
});
