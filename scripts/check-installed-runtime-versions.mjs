// Checks, in an installed copy of the package, that each provider adapter
// resolves the runtime version the package publishes in
// `factoryFactoryRuntimeVersions` (stamped by prepare-runtime-metadata.mjs from
// this repository's lockfile, and the version the recordings in
// src/backend/testing/fixtures/upstream/ were made with). A user's npm install
// can resolve a different one when an adapter asks for a range.
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runtimeManifestPath } from './runtime-manifest-path.mjs';

const PROVIDERS = {
  claude: ['@agentclientprotocol/claude-agent-acp', '@anthropic-ai/claude-agent-sdk'],
  codex: ['@agentclientprotocol/codex-acp', '@openai/codex'],
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const directory = process.argv[2];
if (!directory) {
  throw new Error('Expected the installed factory-factory package directory');
}
const manifestPath = resolve(realpathSync(directory), 'package.json');
const published = readJson(manifestPath).factoryFactoryRuntimeVersions;
if (!published) {
  throw new Error(`${manifestPath} publishes no factoryFactoryRuntimeVersions`);
}
const fromPackage = createRequire(manifestPath);
const mismatches = [];
for (const [tool, [adapter, runtime]] of Object.entries(PROVIDERS)) {
  const fromAdapter = createRequire(fromPackage.resolve(`${adapter}/package.json`));
  const installed = readJson(runtimeManifestPath(fromAdapter, runtime)).version;
  if (installed !== published[tool]) {
    mismatches.push(
      `${adapter} resolves ${runtime} ${installed}, but the package publishes ${tool} ${published[tool]}`
    );
  }
}
if (mismatches.length > 0) {
  console.error(
    `Installed provider runtimes differ from the published, recorded versions:\n${mismatches.join('\n')}`
  );
  process.exit(1);
}
console.log(
  `Installed provider runtimes match the published versions: ${JSON.stringify(published)}`
);
