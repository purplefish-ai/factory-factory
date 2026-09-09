// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { LineTokenMap } from '@/lib/diff/syntax-highlight';
import './diff-highlight.worker';

describe('diff highlighting worker', () => {
  it('preserves multiline syntax and maps old/new tokens to original diff rows', () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          lines: [
            { type: 'hunk', content: '@@ -1,3 +1,3 @@' },
            { type: 'context', content: '/* comment begins' },
            { type: 'deletion', content: 'old comment' },
            { type: 'addition', content: 'new comment' },
            { type: 'context', content: '*/' },
          ],
          language: 'typescript',
          theme: { comment: { color: 'gray', fontStyle: undefined } },
        },
      })
    );
    const tokens = post.mock.calls[0]?.[0] as LineTokenMap;
    expect(tokens).not.toBeNull();
    expect(tokens.has(0)).toBe(false);
    expect(tokens.get(2)).toEqual([
      { content: 'old comment', style: { color: 'gray', fontStyle: undefined } },
    ]);
    expect(tokens.get(3)).toEqual([
      { content: 'new comment', style: { color: 'gray', fontStyle: undefined } },
    ]);
  });

  it('returns a plain-text fallback for malformed requests', () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    window.dispatchEvent(new MessageEvent('message', { data: { lines: 'invalid' } }));
    expect(post.mock.calls[0]?.[0]).toBeNull();
  });
});
