// @vitest-environment jsdom

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, type TestContext, test, vi } from 'vitest';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { renderStreamdownContent } from './streamdown-markdown';
import { STREAMING_CODE, STREAMING_PROSE } from './streamdown-markdown.fixtures';

const variants = [
  { name: 'React Markdown blocks', renderContent: undefined, streaming: true },
  { name: 'Streamdown word fades', renderContent: renderStreamdownContent, streaming: true },
];

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {
      /* No preference changes during a benchmark sample. */
    },
    removeEventListener: () => {
      /* No listeners are retained by this fixed preference. */
    },
  }));
});
afterEach(() => vi.unstubAllGlobals());

function compare(base: string, chunk = ' growing') {
  return async ({ bench }: TestContext) => {
    const roots = variants.map(() => createRoot(document.createElement('div')));
    try {
      await bench.compare(
        ...variants.map((variant, index) => {
          let step = 0;
          return bench(variant.name, () => {
            // Append a bounded tail, then restart. Avoid an ever-growing sample
            // and exercise append-only block reuse on 31 out of 32 updates.
            const content = base + chunk.repeat(++step % 32);
            flushSync(() =>
              roots[index]?.render(
                <MarkdownRenderer
                  content={content}
                  streaming={variant.streaming}
                  renderContent={variant.renderContent}
                />
              )
            );
          });
        })
      );
    } finally {
      for (const root of roots) {
        root.unmount();
      }
    }
  };
}

test(
  '20 KB completed prefix with a growing paragraph',
  compare(
    `${Array.from({ length: Math.ceil(20_000 / STREAMING_PROSE.length) }, () => STREAMING_PROSE).join('\n\n')}\n\nTail`
  ),
  180_000
);
test(
  'growing fenced code block',
  compare(STREAMING_CODE.slice(0, STREAMING_CODE.lastIndexOf('```')), 'const streamed = 1;\n'),
  180_000
);
