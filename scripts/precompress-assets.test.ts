import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { build } from 'vite';
import { afterEach, expect, it } from 'vitest';
import { precompressDirectory } from './precompress-assets';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ff-precompress-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const script = `export const value = "${'abc'.repeat(2000)}";`;

it('writes Brotli and gzip siblings that decode to the original text files', async () => {
  const root = fixture({ 'assets/app.js': script, 'fonts/font.ttf': 'glyph'.repeat(1000) });
  await precompressDirectory(root);

  for (const file of ['assets/app.js', 'fonts/font.ttf']) {
    const original = readFileSync(join(root, file));
    expect(brotliDecompressSync(readFileSync(join(root, `${file}.br`)))).toEqual(original);
    expect(gunzipSync(readFileSync(join(root, `${file}.gz`)))).toEqual(original);
  }
});

it('skips small files and formats that are already compressed', async () => {
  const root = fixture({
    'small.js': 'export {};',
    'image.png': 'png'.repeat(1000),
    'font.woff2': 'woff'.repeat(1000),
  });
  await precompressDirectory(root);

  for (const file of ['small.js', 'image.png', 'font.woff2']) {
    expect(existsSync(join(root, `${file}.br`))).toBe(false);
    expect(existsSync(join(root, `${file}.gz`))).toBe(false);
  }
});

it('removes a stale sibling when a rebuilt file no longer qualifies', async () => {
  const root = fixture({ 'index.html': `<p>${'x'.repeat(4000)}</p>` });
  await precompressDirectory(root);
  expect(existsSync(join(root, 'index.html.br'))).toBe(true);

  writeFileSync(join(root, 'index.html'), '<p>tiny</p>');
  await precompressDirectory(root);
  expect(existsSync(join(root, 'index.html.br'))).toBe(false);
  expect(existsSync(join(root, 'index.html.gz'))).toBe(false);
});

it('precompresses chunks and copied public files in the production build', async () => {
  const root = fixture({
    'entry.js': `globalThis.value = "${'payload '.repeat(500)}";`,
    'public/manifest.webmanifest': JSON.stringify({ name: 'x'.repeat(2000) }),
  });
  await build({
    configFile: resolve('vite.config.ts'),
    root,
    publicDir: join(root, 'public'),
    logLevel: 'silent',
    build: {
      outDir: join(root, 'dist'),
      rolldownOptions: {
        input: join(root, 'entry.js'),
        output: { entryFileNames: 'assets/index-fixture.js' },
      },
    },
  });

  for (const file of ['assets/index-fixture.js', 'manifest.webmanifest']) {
    expect(existsSync(join(root, 'dist', `${file}.br`))).toBe(true);
    expect(existsSync(join(root, 'dist', `${file}.gz`))).toBe(true);
  }
}, 60_000);
