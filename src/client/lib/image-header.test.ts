import { describe, expect, it } from 'vitest';
import { readImageHeader } from './image-header';
import { gifHeader, jpegHeader, pngHeader, webpHeader } from './image-header.test-helpers';

describe('readImageHeader', () => {
  it('reads PNG dimensions', () => {
    expect(readImageHeader(pngHeader(5120, 2880))).toEqual({
      width: 5120,
      height: 2880,
      animated: false,
    });
  });

  it('reports an APNG as animated', () => {
    expect(readImageHeader(pngHeader(3000, 2000, { animated: true }))?.animated).toBe(true);
  });

  it('treats a PNG whose metadata runs past the bytes read as animated, to be safe', () => {
    expect(readImageHeader(pngHeader(3000, 2000).subarray(0, 40))?.animated).toBe(true);
  });

  it('reads JPEG dimensions after metadata segments, in stored orientation', () => {
    expect(readImageHeader(jpegHeader(4032, 3024))).toEqual({
      width: 4032,
      height: 3024,
      animated: false,
    });
  });

  it('reads progressive JPEG dimensions', () => {
    expect(readImageHeader(jpegHeader(800, 600, { progressive: true }))).toMatchObject({
      width: 800,
      height: 600,
    });
  });

  it.each([
    ['VP8X', false],
    ['VP8X', true],
    ['VP8 ', false],
    ['VP8L', false],
  ] as const)('reads %s WebP dimensions (animated %s)', (chunk, animated) => {
    expect(readImageHeader(webpHeader(chunk, 4000, 3000, animated))).toEqual({
      width: 4000,
      height: 3000,
      animated,
    });
  });

  it.each([
    ['a GIF', gifHeader()],
    ['empty bytes', new Uint8Array()],
    ['a JPEG without a frame header', jpegHeader(10, 10).subarray(0, 30)],
    ['a truncated PNG', pngHeader(10, 10).subarray(0, 20)],
  ])('returns null for %s', (_label, bytes) => {
    expect(readImageHeader(bytes)).toBeNull();
  });
});
