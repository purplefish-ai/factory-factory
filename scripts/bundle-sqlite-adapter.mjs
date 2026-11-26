import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The upstream adapter requires better-sqlite3 v12. Bundle its JavaScript so npm
// consumers and Electron resolve the same external v13 driver as migrations.
const output = 'dist/src/backend/lib/sqlite-adapter.js';
await build({
  entryPoints: ['src/backend/lib/sqlite-adapter.ts'],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3'],
});
copyFileSync(
  fileURLToPath(new URL('../LICENSE', import.meta.resolve('@prisma/adapter-better-sqlite3'))),
  join(dirname(output), 'sqlite-adapter.LICENSE')
);
