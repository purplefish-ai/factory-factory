// @vitest-environment jsdom

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer, type MarkdownRendererProps } from './markdown';

afterEach(() => {
  document.body.innerHTML = '';
});

const REPLY = [
  '# Plan',
  '',
  'First paragraph with **bold**, `code` and a [link](https://example.com).',
  'It continues on a second line.',
  '',
  '```ts',
  'const a = 1;',
  '',
  'const b = 2;',
  '```',
  '',
  '- tight item',
  '- another',
  '  - nested',
  '',
  '- loose item',
  '',
  '  continued paragraph',
  '',
  '1. ordered',
  '2. list',
  '',
  'Between lists.',
  '',
  '| Column | Value |',
  '| ------ | ----: |',
  '| a      |     1 |',
  '',
  '> Quoted',
  '> text',
  '',
  '> Second quote',
  '',
  '    indented code',
  '',
  '    more indented code',
  '',
  '~~~',
  'tilde fence',
  '',
  '~~~',
  '',
  '---',
  '',
  '1. Step with a nested fence',
  '',
  '   ```sh',
  '   pnpm test',
  '',
  '   pnpm check',
  '   ```',
  '',
  'Inline <pre> and <!-- x --> stay in their paragraph.',
  '',
  'Final ~~struck~~ paragraph with https://autolink.example.',
].join('\n');

function streamingPrefixEnds() {
  const ends = new Set<number>([REPLY.length]);
  for (let end = 0; end <= REPLY.length; end += 29) {
    ends.add(end);
  }
  // Compare at every line boundary, where block edges appear.
  for (let end = REPLY.indexOf('\n'); end !== -1; end = REPLY.indexOf('\n', end + 1)) {
    ends.add(end);
    ends.add(end + 1);
  }
  return [...ends];
}

function renderHtml(props: MarkdownRendererProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(MarkdownRenderer, props)));
  // Block-wise rendering omits the newline text nodes react-markdown places between blocks.
  const html = container.innerHTML.replace(/>\s+</g, '><');
  root.unmount();
  container.remove();
  return html;
}

describe('MarkdownRenderer streaming blocks', () => {
  it('renders sampled and line-boundary prefixes exactly like the whole document', () => {
    for (const end of streamingPrefixEnds()) {
      const content = REPLY.slice(0, end);
      expect(renderHtml({ content, streaming: true }), `prefix of ${end}`).toBe(
        renderHtml({ content })
      );
    }
  }, 30_000);

  it.each([
    ['reference links', 'See [docs][ref].\n\nMore text.\n\n[ref]: https://example.com'],
    ['footnotes', 'A claim[^1].\n\nMore text.\n\n[^1]: The source.'],
    ['list-item fences ended by unindented text', '- item\n  ```\n  code\nfoo\n\nbar\n```\n\nbaz'],
  ])('matches the whole-document render for %s', (_name, content) => {
    expect(renderHtml({ content, streaming: true })).toBe(renderHtml({ content }));
  });

  it('re-renders only the growing tail block while streaming', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const resolveWorkspaceFileLink = vi.fn(() => null);
    const render = (content: string) =>
      flushSync(() =>
        root.render(
          createElement(MarkdownRenderer, { content, streaming: true, resolveWorkspaceFileLink })
        )
      );

    render('[stable](https://example.com)\n\nGrowing');
    expect(resolveWorkspaceFileLink).toHaveBeenCalledTimes(1);
    render('[stable](https://example.com)\n\nGrowing tail');
    render('[stable](https://example.com)\n\nGrowing tail text');
    expect(resolveWorkspaceFileLink).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Growing tail text');

    root.unmount();
  });
});
