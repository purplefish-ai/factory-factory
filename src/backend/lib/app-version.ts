import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const manifestSchema = z.object({ name: z.literal('factory-factory'), version: z.string() });

/** Works from source, compiled CLI, and unpacked Electron backend directories. */
export function readAppVersion(): string | undefined {
  // Electron keeps the manifest in app.asar even when the backend is unpacked.
  const modulePath = fileURLToPath(import.meta.url).replace(/\.asar\.unpacked([/\\])/, '.asar$1');
  let directory = dirname(modulePath);
  while (true) {
    try {
      const manifest = manifestSchema.safeParse(
        JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      );
      if (manifest.success) {
        return manifest.data.version;
      }
    } catch {
      // Continue through directories without a package manifest.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}
