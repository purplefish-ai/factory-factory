#!/usr/bin/env node
/**
 * Bundle backend for Electron distribution using esbuild.
 * Produces minimal bundles by:
 * - Tree-shaking unused code
 * - Marking native modules as external (they must be included separately)
 * - Bundling all pure JS dependencies into single files
 */

import * as esbuild from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Native modules that cannot be bundled (require runtime binaries)
const EXTERNAL_MODULES = [
  // Native Node.js addons
  'better-sqlite3',
  'node-pty',
  // Prisma uses native query engine
  '@prisma/client',
];

// Banner to add CJS compatibility to ESM bundle
// This creates a proper require function for packages that use dynamic require
const esmBanner = `
import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_fn } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_fn(__filename);
`.trim();

// Common esbuild options
const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  // Mark native modules as external
  external: EXTERNAL_MODULES,
  // Tree-shake unused exports
  treeShaking: true,
  // Keep names for better error messages
  keepNames: true,
  // Add CJS compatibility banner
  banner: { js: esmBanner },
};

async function bundle() {
  const outdir = join(projectRoot, 'dist-bundle');

  // Ensure output directory exists
  if (!existsSync(outdir)) {
    mkdirSync(outdir, { recursive: true });
  }

  console.log('Bundling backend for Electron...');

  // Bundle main backend server
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(projectRoot, 'src/backend/index.ts')],
    outfile: join(outdir, 'backend.mjs'),
  });
  console.log('✓ Bundled backend.mjs');

  // Bundle migration script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(projectRoot, 'src/backend/migrate.ts')],
    outfile: join(outdir, 'migrate.mjs'),
  });
  console.log('✓ Bundled migrate.mjs');

  console.log(`\nBundle complete! Output: ${outdir}`);
}

bundle().catch((err) => {
  console.error('Bundle failed:', err);
  process.exit(1);
});
