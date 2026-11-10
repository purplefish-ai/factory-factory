import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MONO_FONT_OPTIONS, SANS_FONT_OPTIONS } from '@/shared/appearance';

const repoRoot = resolve(import.meta.dirname, '../..');
const indexHtml = readFileSync(resolve(repoRoot, 'index.html'), 'utf8');
const fontsCss = readFileSync(resolve(import.meta.dirname, 'fonts.css'), 'utf8');

const fontFaces = [...fontsCss.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body = '']) => ({
  family: body.match(/font-family:\s*'([^']+)'/)?.[1],
  src: body.match(/src:\s*url\('([^']+)'\)/)?.[1],
}));
const bundledFamilies = new Set(fontFaces.map((face) => face.family));

// Families the device provides. Every other preset family must ship with the
// app, so choosing it never depends on a font CDN.
const DEVICE_FAMILIES = new Set(['Monaco', 'ui-sans-serif', 'ui-monospace']);

function primaryFamily(stack: string): string {
  return (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

describe('font loading', () => {
  it('loads no cross-origin resources from index.html', () => {
    const tags = [...indexHtml.matchAll(/<(?:link|script)\b[^>]*>/gi)].map(([tag]) => tag);
    // Double-quoted, single-quoted and unquoted attribute values.
    const urls = tags.flatMap((tag) =>
      [...tag.matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)].map(
        ([, double, single, bare]) => (double ?? single ?? bare ?? '').trim()
      )
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(url))).toEqual([]);
  });

  it.each(
    [...SANS_FONT_OPTIONS, ...MONO_FONT_OPTIONS].flatMap((option) =>
      option.value ? [{ label: option.label, family: primaryFamily(option.value) }] : []
    )
  )('bundles or relies on the device for the $label preset', ({ family }) => {
    expect(DEVICE_FAMILIES.has(family) || bundledFamilies.has(family)).toBe(true);
  });

  it('serves every face from a bundled file next to its license', () => {
    expect(fontFaces.length).toBeGreaterThan(0);
    for (const { family, src } of fontFaces) {
      expect(family, `font-face missing a quoted family: ${src}`).toBeDefined();
      expect(src, `${family} must load from /fonts/`).toMatch(/^\/fonts\/[^/]+\/[^/]+\.woff2$/);
      const file = resolve(repoRoot, 'public', `.${src}`);
      expect(existsSync(file), `${src} is missing from public/`).toBe(true);
      expect(existsSync(resolve(dirname(file), 'OFL.txt')), `${src} has no OFL.txt`).toBe(true);
    }
  });
});
