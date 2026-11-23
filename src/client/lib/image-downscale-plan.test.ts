import { describe, expect, it } from 'vitest';
import {
  DOWNSCALE_LIMITS,
  downscaleDimensions,
  keepsOriginal,
  MAX_DECODE_PIXELS,
  nameForType,
  planDownscale,
} from './image-downscale-plan';

describe('downscale plan', () => {
  it('caps at the high-resolution Claude tier: 2576 px and 4,784 visual tokens', () => {
    expect(DOWNSCALE_LIMITS).toEqual({ maxEdge: 2576, maxPixels: 3_750_656 });
  });

  it.each([
    [2576, 1449],
    [1449, 2576],
    [1936, 1936],
    [2576, 1],
    [0, 5000],
    [Number.NaN, 5000],
  ])('leaves %d x %d alone', (width, height) => {
    expect(downscaleDimensions(width, height)).toBeNull();
  });

  it.each([
    // 5K display screenshot: the long edge binds.
    [5120, 2880, 2576, 1449],
    // 12 MP phone photo, landscape and portrait: the pixel budget binds.
    [4032, 3024, 2236, 1677],
    [3024, 4032, 1677, 2236],
    // A square just over the budget.
    [2000, 2000, 1936, 1936],
    // An extreme panorama keeps at least one pixel on the short edge.
    [100_000, 10, 2576, 1],
  ])('scales %d x %d to %d x %d', (width, height, targetWidth, targetHeight) => {
    const target = downscaleDimensions(width, height);
    expect(target).toEqual({ width: targetWidth, height: targetHeight });
    expect(targetWidth * targetHeight).toBeLessThanOrEqual(DOWNSCALE_LIMITS.maxPixels);
  });

  it('honours explicit limits', () => {
    expect(downscaleDimensions(2000, 1000, { maxEdge: 1000, maxPixels: 10_000_000 })).toEqual({
      width: 1000,
      height: 500,
    });
  });

  const over = { width: 4032, height: 3024, animated: false };

  it.each([
    ['image/jpeg', 'image/jpeg'],
    ['image/jpg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/png'],
    ['image/gif', null],
    ['image/svg+xml', null],
    ['image/heic', null],
    ['', null],
  ])('re-encodes an oversized %j as %j', (type, output) => {
    expect(planDownscale(type, over)).toBe(output);
  });

  it.each([
    ['an unreadable header', null],
    ['an animated image', { ...over, animated: true }],
    ['an image within the cap', { width: 2576, height: 1449, animated: false }],
    ['an image too large to decode safely', { width: 10_000, height: 5001, animated: false }],
  ])('uploads %s unchanged', (_label, header) => {
    expect(planDownscale('image/png', header)).toBeNull();
  });

  it('still decodes a 48 MP phone photo', () => {
    expect(MAX_DECODE_PIXELS).toBeGreaterThan(8064 * 6048);
    expect(planDownscale('image/jpeg', { width: 8064, height: 6048, animated: false })).toBe(
      'image/jpeg'
    );
  });

  it.each([
    [1000, 999, false],
    [1000, 1000, true],
    [1000, 1001, true],
  ])('original of %d bytes against %d encoded keeps original: %s', (original, encoded, keep) => {
    expect(keepsOriginal(original, encoded)).toBe(keep);
  });

  it.each([
    ['photo.webp', 'image/webp', 'image/png', 'photo.png'],
    ['photo.WEBP', 'image/webp', 'image/png', 'photo.png'],
    ['photo.jpg', 'image/jpg', 'image/jpeg', 'photo.jpg'],
    ['shot.png', 'image/png', 'image/png', 'shot.png'],
    ['no-extension', 'image/webp', 'image/png', 'no-extension.png'],
  ] as const)('names %j (%s) encoded as %s %j', (name, from, to, expected) => {
    expect(nameForType(name, from, to)).toBe(expected);
  });
});
