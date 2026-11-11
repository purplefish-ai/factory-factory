import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Text-like formats; images, woff2, audio and other compressed formats are excluded. */
const COMPRESSIBLE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.otf',
  '.svg',
  '.ttf',
  '.txt',
  '.wasm',
  '.webmanifest',
  '.xml',
]);
/** Below this, headers dominate the transfer and a sibling only adds package size. */
const MIN_BYTES = 1024;
/** A sibling must save at least 10% to be worth shipping and serving. */
const MAX_RATIO = 0.9;

const encoders = [
  {
    suffix: '.br',
    encode: (source: Buffer) =>
      brotliAsync(source, {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
        },
      }),
  },
  { suffix: '.gz', encode: (source: Buffer) => gzipAsync(source, { level: 9 }) },
];

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function precompressFile(file: string): Promise<void> {
  const source = await readFile(file);
  await Promise.all(
    encoders.map(async ({ suffix, encode }) => {
      const encoded = source.length >= MIN_BYTES ? await encode(source) : null;
      if (encoded && encoded.length <= source.length * MAX_RATIO) {
        await writeFile(`${file}${suffix}`, encoded);
      } else {
        // A rebuild without emptyOutDir must not leave a sibling for older content.
        await rm(`${file}${suffix}`, { force: true });
      }
    })
  );
}

/** Writes `.br` and `.gz` siblings for every compressible file in a directory tree. */
export async function precompressDirectory(directory: string): Promise<void> {
  const files = (await listFiles(directory)).filter((file) =>
    COMPRESSIBLE_EXTENSIONS.has(extname(file).toLowerCase())
  );
  await Promise.all(files.map(precompressFile));
}

/**
 * Emits Brotli and gzip siblings after the build, including copied public files,
 * so the backend can serve remote clients compressed bytes without request-time CPU.
 */
export function precompressAssets(): Plugin {
  return {
    name: 'precompress-assets',
    apply: 'build',
    async writeBundle(options) {
      if (options.dir) {
        await precompressDirectory(options.dir);
      }
    },
  };
}
