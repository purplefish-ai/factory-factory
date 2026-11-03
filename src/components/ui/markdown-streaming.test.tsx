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
  'Final ~~struck~~ paragraph with https://autolink.example.',
].join('\n');

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
  it('renders every streaming prefix exactly like the whole document', () => {
    for (let end = 0; end <= REPLY.length; end += 7) {
      const content = REPLY.slice(0, end);
      expect(renderHtml({ content, streaming: true }), `prefix of ${end}`).toBe(
        renderHtml({ content })
      );
    }
    expect(renderHtml({ content: REPLY, streaming: true })).toBe(renderHtml({ content: REPLY }));
  });

  it.each([
    ['reference links', 'See [docs][ref].\n\nMore text.\n\n[ref]: https://example.com'],
    ['footnotes', 'A claim[^1].\n\nMore text.\n\n[^1]: The source.'],
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
