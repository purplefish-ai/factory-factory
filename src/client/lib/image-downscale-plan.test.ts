import { describe, expect, it } from 'vitest';
import {
  DOWNSCALE_MAX_EDGE,
  downscaleDimensions,
  downscaleOutputType,
  keepsOriginal,
  nameForType,
} from './image-downscale-plan';

describe('downscale plan', () => {
  it('caps the longest edge at the high-resolution Claude tier', () => {
    expect(DOWNSCALE_MAX_EDGE).toBe(2576);
  });

  it.each([
    [DOWNSCALE_MAX_EDGE, DOWNSCALE_MAX_EDGE],
    [DOWNSCALE_MAX_EDGE, 1],
    [1, DOWNSCALE_MAX_EDGE],
    [1290, 2796 / 2],
    [0, 5000],
    [Number.NaN, 5000],
  ])('leaves %d x %d alone', (width, height) => {
    expect(downscaleDimensions(width, height)).toBeNull();
  });

  it.each([
    // 12 MP iPhone photo, landscape and portrait.
    [4032, 3024, 2576, 1932],
    [3024, 4032, 1932, 2576],
    // 5K display screenshot.
    [5120, 2880, 2576, 1449],
    // One pixel over the cap.
    [DOWNSCALE_MAX_EDGE + 1, DOWNSCALE_MAX_EDGE + 1, 2576, 2576],
    // An extreme panorama keeps at least one pixel on the short edge.
    [100_000, 10, 2576, 1],
  ])('scales %d x %d to %d x %d', (width, height, targetWidth, targetHeight) => {
    expect(downscaleDimensions(width, height)).toEqual({
      width: targetWidth,
      height: targetHeight,
    });
  });

  it('honours an explicit cap', () => {
    expect(downscaleDimensions(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
  });

  it.each([
    ['image/jpeg', 'image/jpeg'],
    ['image/jpg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/png'],
    ['image/gif', null],
    ['image/svg+xml', null],
    ['image/heic', null],
    ['', null],
  ])('encodes %j as %j', (type, output) => {
    expect(downscaleOutputType(type)).toBe(output);
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
