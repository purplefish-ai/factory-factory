// Where a provider runtime's package.json is, resolved the way its adapter
// resolves the runtime. Shared by prepare-runtime-metadata.mjs (the versions a
// release publishes), the upstream recorder and the installed-package check.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `fromAdapter` is a require function created at the adapter's package.json. */
export function runtimeManifestPath(fromAdapter, runtime) {
  try {
    return fromAdapter.resolve(`${runtime}/package.json`);
  } catch {
    let directory = dirname(fromAdapter.resolve(runtime));
    while (true) {
      const path = join(directory, 'package.json');
      try {
        if (JSON.parse(readFileSync(path, 'utf8')).name === runtime) {
          return path;
        }
      } catch {
        /* The exported entrypoint may be nested inside its package. */
      }
      const parent = dirname(directory);
      if (parent === directory) {
        throw new Error(`Unable to locate ${runtime} package metadata`);
      }
      directory = parent;
    }
  }
}
