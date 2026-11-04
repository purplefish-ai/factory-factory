import { describe, expect, it } from 'vitest';
import { contrastRatio, mixOver, oklchToRgb, parseThemeColor, rgbToHex } from './color-contrast';

describe('color contrast helpers', () => {
  it('parses hex colors', () => {
    expect(parseThemeColor('#0969da')).toEqual({
      rgb: [9 / 255, 105 / 255, 218 / 255],
      alpha: 1,
    });
    expect(rgbToHex(parseThemeColor('#fff')?.rgb ?? [0, 0, 0])).toBe('#ffffff');
  });

  it('converts OKLCH to sRGB', () => {
    expect(rgbToHex(oklchToRgb(1, 0, 0))).toBe('#ffffff');
    expect(rgbToHex(oklchToRgb(0, 0, 0))).toBe('#000000');
    // Tailwind's red-600 is defined as oklch(0.577 0.245 27.325) ≈ #e7000b.
    expect(rgbToHex(oklchToRgb(0.577, 0.245, 27.325))).toBe('#e7000b');
  });

  it('parses OKLCH with alpha and percentage lightness', () => {
    expect(parseThemeColor('oklch(1 0 0 / 15%)')?.alpha).toBeCloseTo(0.15);
    expect(rgbToHex(parseThemeColor('oklch(50% 0 0)')?.rgb ?? [1, 1, 1])).toBe(
      rgbToHex(oklchToRgb(0.5, 0, 0))
    );
  });

  it('rejects unsupported color syntax', () => {
    expect(parseThemeColor('var(--brand)')).toBeNull();
    expect(parseThemeColor('rgb(0 0 0)')).toBeNull();
  });

  it('rejects malformed OKLCH numbers instead of producing NaN', () => {
    expect(parseThemeColor('oklch(1.2.3 0 0)')).toBeNull();
    expect(parseThemeColor('oklch(. 0 0)')).toBeNull();
    expect(parseThemeColor('oklch(.5 0 0)')?.rgb).toEqual(oklchToRgb(0.5, 0, 0));
  });

  it('clamps alpha like CSS', () => {
    expect(parseThemeColor('oklch(0.5 0 0 / 150%)')?.alpha).toBe(1);
    expect(parseThemeColor('oklch(0.5 0 0 / 2)')?.alpha).toBe(1);
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21);
    expect(contrastRatio([1, 1, 1], [1, 1, 1])).toBeCloseTo(1);
    // #767676 is the classic 4.54:1 gray on white.
    const gray = parseThemeColor('#767676')?.rgb ?? [0, 0, 0];
    expect(contrastRatio(gray, [1, 1, 1])).toBeCloseTo(4.54, 2);
  });

  it('composites a translucent color over a background', () => {
    expect(mixOver([1, 0, 0], [0, 0, 1], 0.25)).toEqual([0.25, 0, 0.75]);
  });
});
