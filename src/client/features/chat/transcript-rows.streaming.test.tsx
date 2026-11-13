// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type ChatMessage } from '@/lib/chat-protocol';
import { createAssistantMessage, createUserMessage } from '@/lib/claude.fixture';
import { TranscriptRenderingFixture } from './transcript-rendering.test-harness';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  // Word fades are disabled for reduced motion; report full motion.
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

const prompt = createUserMessage('Explain the change', 0);
const reply = createAssistantMessage('', 1);
const queued = createUserMessage('Then run the tests', 2);

function withText(text: string): ChatMessage {
  return {
    ...reply,
    message: { type: 'assistant', message: { role: 'assistant', content: text } },
  };
}

it.each([
  ['the last message', false],
  ['followed only by queued prompts', true],
])('streams the reply when it is %s', async (_name, withQueued) => {
  const render = (text: string, running: boolean) =>
    act(() =>
      root.render(
        <TranscriptRenderingFixture
          messages={withQueued ? [prompt, withText(text), queued] : [prompt, withText(text)]}
          queuedMessageIds={withQueued ? new Set([queued.id]) : undefined}
          running={running}
          startingSession={false}
          loadingSession={false}
        />
      )
    );

  await render('First', true);
  await render('First words', true);
  // Streaming updates render as they commit; the reply animates its words.
  expect(container.textContent).toContain('First words');
  expect(container.querySelector('[data-sd-animate]')).not.toBeNull();

  await render('First words, finished.', false);
  expect(container.textContent).toContain('First words, finished.');
  expect(container.querySelector('[data-sd-animate]')).toBeNull();
});

it('renders a reply immediately once another message follows it', async () => {
  const render = (messages: ChatMessage[]) =>
    act(() =>
      root.render(
        <TranscriptRenderingFixture
          messages={messages}
          running
          startingSession={false}
          loadingSession={false}
        />
      )
    );

  await render([prompt, withText('Done')]);
  await render([prompt, withText('Done.'), createUserMessage('Next prompt', 3)]);
  expect(container.textContent).toContain('Done.');
});
