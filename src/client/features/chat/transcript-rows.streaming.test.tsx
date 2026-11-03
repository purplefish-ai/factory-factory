// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type ChatMessage } from '@/lib/chat-protocol';
import { createAssistantMessage, createUserMessage } from '@/lib/claude-fixtures';
import { STREAMING_TEXT_INTERVAL_MS } from './agent-activity/message-renderers/use-streaming-text-snapshot';
import { TranscriptRenderingFixture } from './transcript-rendering.test-utils';

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
])('throttles the streaming reply when it is %s', async (_name, withQueued) => {
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
  expect(container.textContent).toContain('First');
  expect(container.textContent).not.toContain('First words');

  await act(() => {
    vi.advanceTimersByTime(STREAMING_TEXT_INTERVAL_MS);
  });
  expect(container.textContent).toContain('First words');

  await render('First words, finished.', false);
  expect(container.textContent).toContain('First words, finished.');
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
