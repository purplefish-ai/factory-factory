import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from './markdown-blocks';

function split(markdown: string) {
  const blocks = splitMarkdownBlocks(markdown);
  expect(blocks.join('')).toBe(markdown);
  return blocks;
}

describe('splitMarkdownBlocks', () => {
  it('splits paragraphs and headings at blank lines', () => {
    expect(split('# Title\n\nFirst paragraph\nstill first.\n\nSecond.')).toEqual([
      '# Title\n\n',
      'First paragraph\nstill first.\n\n',
      'Second.',
    ]);
  });

  it('keeps a single block when there is no blank line', () => {
    expect(split('one\ntwo\nthree')).toEqual(['one\ntwo\nthree']);
    expect(split('')).toEqual(['']);
  });

  it('keeps trailing and leading blank lines in their neighbouring block', () => {
    expect(split('\n\nfirst\n\n')).toEqual(['\n\nfirst\n\n']);
    expect(split('first\n\n\n\nsecond')).toEqual(['first\n\n\n\n', 'second']);
  });

  it('never splits inside backtick or tilde fences', () => {
    const backticks = 'Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter';
    expect(split(backticks)).toEqual([
      'Intro\n\n',
      '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n',
      'After',
    ]);

    const tildes = '~~~\nfirst\n\n```\nnot a close\n\n~~~\n\nAfter';
    expect(split(tildes)).toEqual(['~~~\nfirst\n\n```\nnot a close\n\n~~~\n\n', 'After']);
  });

  it('requires a closing fence at least as long as the opening fence', () => {
    const markdown = '````md\n```\n\ninner\n```\n\nstill code\n````\n\nAfter';
    expect(split(markdown)).toEqual(['````md\n```\n\ninner\n```\n\nstill code\n````\n\n', 'After']);
  });

  it('keeps an unclosed streaming fence in the last block', () => {
    expect(split('Intro\n\n```\ncode\n\nmore code')).toEqual([
      'Intro\n\n',
      '```\ncode\n\nmore code',
    ]);
  });

  it('treats a backtick line with backticks in its info string as inline code', () => {
    expect(split('```inline``` text\n\nnext')).toEqual(['```inline``` text\n\n', 'next']);
  });

  it('keeps nested and loose lists together', () => {
    const markdown =
      '- one\n\n  continued\n\n  - nested\n\n    deeper\n\n- two\n\n1. ordered\n\n2. next';
    expect(split(markdown)).toEqual([markdown]);
  });

  it('splits after a list only before an unindented non-list line', () => {
    expect(split('- one\n- two\n\nParagraph')).toEqual(['- one\n- two\n\n', 'Paragraph']);
  });

  it('keeps indented code that contains blank lines together', () => {
    const markdown = 'Text\n\n    code\n\n    more code\n\nAfter';
    expect(split(markdown)).toEqual(['Text\n\n    code\n\n    more code\n\n', 'After']);
  });

  it('keeps tables whole and splits around them', () => {
    const markdown = 'Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter';
    expect(split(markdown)).toEqual(['Intro\n\n', '| a | b |\n| - | - |\n| 1 | 2 |\n\n', 'After']);
  });

  it('splits between blockquotes separated by a blank line', () => {
    expect(split('> quoted\n> more\n\n> another')).toEqual(['> quoted\n> more\n\n', '> another']);
  });

  it('handles CRLF line endings', () => {
    expect(split('one\r\n\r\ntwo')).toEqual(['one\r\n\r\n', 'two']);
  });

  it.each([
    ['link reference definitions', 'See [docs][ref].\n\n[ref]: https://example.com\n\nAfter'],
    ['footnotes', 'Claim[^1].\n\nMore\n\n[^1]: Source.'],
    ['nested definitions', 'Text\n\n> [ref]: https://example.com\n\nAfter'],
    ['HTML comments', 'Before\n\n<!--\n\nhidden\n\n-->\n\nAfter'],
    ['pre blocks', 'Before\n\n<pre>\n\nraw\n\n</pre>\n\nAfter'],
  ])('falls back to a single block for %s', (_name, markdown) => {
    expect(split(markdown)).toEqual([markdown]);
  });

  it('ignores definition-like and HTML-like text inside fences', () => {
    const markdown = '```\n[ref]: value\n<!-- x\n```\n\nAfter';
    expect(split(markdown)).toEqual(['```\n[ref]: value\n<!-- x\n```\n\n', 'After']);
  });
});
