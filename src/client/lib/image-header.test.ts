import { describe, expect, it } from 'vitest';
import { INCOMPLETE, readImageHeader } from './image-header';
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
    expect(readImageHeader(pngHeader(3000, 2000, { animated: true }))).toMatchObject({
      animated: true,
    });
  });

  it.each([
    ['PNG metadata', pngHeader(3000, 2000).subarray(0, 40)],
    ['a PNG signature', pngHeader(3000, 2000).subarray(0, 20)],
    ['JPEG metadata', jpegHeader(10, 10).subarray(0, 30)],
    ['a JPEG frame header', jpegHeader(10, 10).subarray(0, -12)],
    ['a WebP chunk', webpHeader('VP8X', 10, 10).subarray(0, 24)],
  ])('reports bytes that end inside %s as incomplete', (_label, bytes) => {
    expect(readImageHeader(bytes)).toBe(INCOMPLETE);
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
    ['a JPEG with a corrupt segment', new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00])],
  ])('returns null for %s', (_label, bytes) => {
    expect(readImageHeader(bytes)).toBeNull();
  });
});
