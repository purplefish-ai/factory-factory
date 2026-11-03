// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { type TestContext, test } from 'vitest';
import { MarkdownRenderer } from './markdown';

const SECTION = [
  '## Step',
  '',
  'This paragraph explains the change with **bold** text, `inline code` and a',
  '[reference](https://example.com/docs) to the relevant documentation page.',
  '',
  '```ts',
  'export function example(value: number): number {',
  '  const doubled = value * 2;',
  '',
  '  return doubled + 1;',
  '}',
  '```',
  '',
  '- First consideration with some detail',
  '- Second consideration',
  '  - Nested follow-up',
  '',
  '| File | Change |',
  '| ---- | ------ |',
  '| a.ts | Added  |',
  '| b.ts | Fixed  |',
  '',
  '',
].join('\n');

// Whole sections keep every fence closed, so the streaming tail is a paragraph.
function reply(bytes: number) {
  return SECTION.repeat(Math.max(1, Math.round(bytes / SECTION.length)));
}

function benchStreamingStep(bytes: number) {
  return async ({ bench }: TestContext) => {
    const base = `${reply(bytes)}The streaming tail paragraph`;
    const tails = [' grows', ' grows again'];
    const container = document.createElement('div');
    const single = createRoot(container);
    const blocks = createRoot(document.createElement('div'));
    let step = 0;

    await bench.compare(
      bench(`single parse per delta (${bytes / 1000} KB)`, () => {
        step += 1;
        flushSync(() =>
          single.render(createElement(MarkdownRenderer, { content: base + tails[step % 2] }))
        );
      }),
      bench(`block parse per delta (${bytes / 1000} KB)`, () => {
        step += 1;
        flushSync(() =>
          blocks.render(
            createElement(MarkdownRenderer, { content: base + tails[step % 2], streaming: true })
          )
        );
      })
    );
    single.unmount();
    blocks.unmount();
  };
}

// jsdom DOM work dominates large single parses; allow slow loaded machines to finish.
const TIMEOUT_MS = 180_000;
test('streaming Markdown render cost at 2 KB', benchStreamingStep(2000), TIMEOUT_MS);
test('streaming Markdown render cost at 20 KB', benchStreamingStep(20_000), TIMEOUT_MS);
