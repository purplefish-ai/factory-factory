// The launcher imports this module on older Node, before it can load application dependencies.
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveSqliteDrivers(
  packageRoot,
  sourceCheckout = existsSync(join(packageRoot, 'src/cli/index.ts'))
) {
  const app = createRequire(join(packageRoot, 'package.json'));
  // Source checkouts and older releases use the upstream package. New releases
  // bundle its JavaScript and resolve the external driver beside the built adapter.
  const upstream = '@prisma/adapter-better-sqlite3';
  const adapter = createRequire(
    app.resolve(
      sourceCheckout || app('./package.json').dependencies?.[upstream]
        ? upstream
        : './dist/src/backend/lib/sqlite-adapter.js'
    )
  );
  return [
    ['factory-factory', app],
    ['@prisma/adapter-better-sqlite3', adapter],
  ].map(([consumer, require]) => {
    const path = realpathSync(require.resolve('better-sqlite3/package.json'));
    return { consumer, path, version: require(path).version };
  });
}

export class NativeBindingError extends Error {}

export function probeSqliteDrivers(drivers) {
  const checked = new Set();
  for (const { consumer, path, version } of drivers) {
    if (checked.has(path)) {
      continue;
    }
    let database;
    try {
      const Database = createRequire(path)('./');
      database = new Database(':memory:');
    } catch (error) {
      if (
        error.code === 'ERR_DLOPEN_FAILED' ||
        (error.code === 'MODULE_NOT_FOUND' &&
          /^Cannot find module '[^'\n]+\.node'/.test(error.message)) ||
        error.message.startsWith('Could not locate the bindings file.')
      ) {
        throw new NativeBindingError(
          `${consumer} could not load better-sqlite3@${version} (${path}) with Node.js ${process.versions.node} (ABI ${process.versions.modules}): ${error.message}`
        );
      }
      throw error;
    }
    try {
      if (database.prepare('SELECT 1 AS value').get().value !== 1) {
        throw new Error(`SQLite query failed for ${consumer} (${path}).`);
      }
    } finally {
      database.close();
    }
    checked.add(path);
  }
}

// The update supervisor validates the staged package in a short-lived process.
if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const packageRoot = process.argv[2];
  probeSqliteDrivers(resolveSqliteDrivers(packageRoot));
  createRequire(join(packageRoot, 'package.json'))('node-pty');
}
