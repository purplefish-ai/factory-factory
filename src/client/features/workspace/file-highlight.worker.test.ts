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
