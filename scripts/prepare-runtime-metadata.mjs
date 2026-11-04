import { readFileSync, writeFileSync } from 'node:fs';
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
const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
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
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
