import { describe, expect, it } from 'vitest';
import { selectContentEncoding } from './content-encoding';

describe('selectContentEncoding', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['identity', null],
    ['deflate', null],
    // Chromium lists gzip first; equal quality goes to the smaller br.
    ['gzip, deflate, br, zstd', 'br'],
    // Browsers omit br on plain HTTP origins.
    ['gzip, deflate', 'gzip'],
    ['GZIP', 'gzip'],
    ['br;q=0.5, gzip', 'gzip'],
    ['br;q=0, gzip;q=0', null],
    ['*', 'br'],
    ['*;q=0.5, br;q=0', 'gzip'],
    ['gzip;q=invalid', null],
  ])('selects for %j', (header, expected) => {
    expect(selectContentEncoding(header)).toBe(expected);
  });

  it('only selects codings that are available', () => {
    expect(selectContentEncoding('br, gzip', ['gzip'])).toBe('gzip');
    expect(selectContentEncoding('br', ['gzip'])).toBeNull();
  });
});
