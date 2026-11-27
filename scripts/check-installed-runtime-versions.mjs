// Checks, in an installed copy of the package, that each provider adapter
// resolves the runtime version the package publishes in
// `factoryFactoryRuntimeVersions` (stamped by prepare-runtime-metadata.mjs from
// this repository's lockfile, and the version the recordings in
// src/backend/testing/fixtures/upstream/ were made with). A user's npm install
// can resolve a different one when an adapter asks for a range.
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const PROVIDERS = {
  claude: ['@agentclientprotocol/claude-agent-acp', '@anthropic-ai/claude-agent-sdk'],
  codex: ['@agentclientprotocol/codex-acp', '@openai/codex'],
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Mirrors scripts/prepare-runtime-metadata.mjs, which cannot be imported
// because it rewrites package.json when loaded.
function runtimeManifestPath(fromAdapter, runtime) {
  try {
    return fromAdapter.resolve(`${runtime}/package.json`);
  } catch {
    let directory = dirname(fromAdapter.resolve(runtime));
    while (true) {
      const path = join(directory, 'package.json');
      try {
        if (readJson(path).name === runtime) {
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
