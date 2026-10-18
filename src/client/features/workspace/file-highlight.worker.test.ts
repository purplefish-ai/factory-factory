// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import './diff-highlight.worker';

describe('file highlighting worker', () => {
  it('preserves multiline tokens, blank lines, and the final newline', () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          content: '/* begin\n\nend */\n',
          language: 'typescript',
          theme: { comment: { color: 'gray' } },
        },
      })
    );
    expect(post.mock.calls[0]?.[0]).toEqual(
      new Map([
        [0, [{ content: '/* begin', style: { color: 'gray' } }]],
        [1, []],
        [2, [{ content: 'end */', style: { color: 'gray' } }]],
        [3, []],
      ])
    );
  });
});

it.each(['jsx', 'tsx'])(
  'colors actual JSX tags in %s instead of treating them as operators',
  (language) => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          content: 'const element = <Panel title="Hello" />;',
          language,
          theme: { tag: { color: 'purple' } },
        },
      })
    );
    const tokens = post.mock.calls[0]?.[0] as Map<
      number,
      Array<{ content: string; style?: { color?: string } }>
    >;
    expect(
      tokens.get(0)?.some((token) => token.content === 'Panel' && token.style?.color === 'purple')
    ).toBe(true);
  }
);

it('colors GraphQL keywords', () => {
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        content: 'query Example { viewer { id } }',
        language: 'graphql',
        theme: { keyword: { color: 'purple' } },
      },
    })
  );
  const tokens = post.mock.calls[0]?.[0] as Map<
    number,
    Array<{ content: string; style?: { color?: string } }>
  >;
  expect(
    tokens?.get(0)?.some((token) => token.content === 'query' && token.style?.color === 'purple')
  ).toBe(true);
});

it('omits token-heavy minified blocks from the worker response', () => {
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  const content = `[${'{"x":1},'.repeat(1000)}{"x":1}]`;
  window.dispatchEvent(
    new MessageEvent('message', { data: { content, language: 'json', theme: {} } })
  );
  expect(post.mock.calls[0]?.[0]).toEqual(new Map());
});

it('omits oversized blocks before transfer while preserving multiline syntax in later blocks', () => {
  const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  const content = `/*${'x'.repeat(40_000)}\n${'\n'.repeat(127)}still comment\n*/`;
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { content, language: 'typescript', theme: { comment: { color: 'gray' } } },
    })
  );
  const tokens = post.mock.calls[0]?.[0] as Map<
    number,
    Array<{ content: string; style?: { color?: string } }>
  >;
  expect(tokens.has(0)).toBe(false);
  expect(tokens.get(128)).toEqual([{ content: 'still comment', style: { color: 'gray' } }]);
});
