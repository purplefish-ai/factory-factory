import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const versionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  .refine((version) => version.split('.').every((part) => Number.isSafeInteger(Number(part))));
const manifestSchema = z.looseObject({
  name: z.literal('factory-factory'),
  version: versionSchema,
});
const runtimeSchema = z.object({ version: versionSchema });
const manifestPath = join(process.cwd(), 'package.json');
const originalManifest = readFileSync(manifestPath);
const manifest = manifestSchema.parse(JSON.parse(originalManifest.toString('utf8')));
const fromApp = createRequire(manifestPath);

function runtimeManifestPath(fromAdapter, runtime) {
  try {
    return fromAdapter.resolve(`${runtime}/package.json`);
  } catch {
    let directory = dirname(fromAdapter.resolve(runtime));
    while (true) {
      const path = join(directory, 'package.json');
      try {
        const manifest = z
          .object({ name: z.string() })
          .safeParse(JSON.parse(readFileSync(path, 'utf8')));
        if (manifest.success && manifest.data.name === runtime) {
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

function resolvedRuntimeVersion(adapter, runtime) {
  const fromAdapter = createRequire(fromApp.resolve(`${adapter}/package.json`));
  return runtimeSchema.parse(
    JSON.parse(readFileSync(runtimeManifestPath(fromAdapter, runtime), 'utf8'))
  ).version;
}

// A publish/pack lifecycle step only: never stamp ranges or the app's different direct SDK.
manifest.factoryFactoryRuntimeVersions = {
  claude: resolvedRuntimeVersion(
    '@agentclientprotocol/claude-agent-acp',
    '@anthropic-ai/claude-agent-sdk'
  ),
  codex: resolvedRuntimeVersion('@agentclientprotocol/codex-acp', '@openai/codex'),
};
// Keep the first checkout bytes across retries after a failed or interrupted pack.
// The package's files allowlist excludes this recovery file from the artifact.
const backupPath = join(process.cwd(), '.package.json.runtime-metadata-backup');
if (!existsSync(backupPath)) {
  writeFileSync(backupPath, originalManifest, { flag: 'wx' });
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
