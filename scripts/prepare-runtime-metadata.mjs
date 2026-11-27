import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import { runtimeManifestPath } from './runtime-manifest-path.mjs';

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
