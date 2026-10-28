import { describe, expect, it } from 'vitest';
import { highlightSearchText } from './search-highlight';

describe('search match highlighting', () => {
  it('preserves decomposed display text and surrounding graphemes', () => {
    const text = 'Open E\u0301clair 👍🏽 now';
    const parts = highlightSearchText(text, 'éclair');
    expect(parts.map((part) => part.text).join('')).toBe(text);
    expect(parts.filter((part) => part.matched).map((part) => part.text)).toEqual(['E\u0301clair']);
  });
});
