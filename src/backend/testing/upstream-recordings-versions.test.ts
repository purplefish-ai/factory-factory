import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

// Each provider adapter and the runtime it resolves must have a recording of a
// real session (src/backend/testing/fixtures/upstream/<tool>/<runtime
// version>/), so a version CI has not seen parsed cannot ship. The runtime
// version is the one the release publishes: scripts/prepare-runtime-metadata.mjs
// itself resolves it here. A version bump is a pull request with its new
// recording, made with `node scripts/record-upstream.mjs <tool>`.

const repository = resolve(import.meta.dirname, '..', '..', '..');
const recordings = join(import.meta.dirname, 'fixtures', 'upstream');
const PROVIDERS = {
  claude: {
    adapter: '@agentclientprotocol/claude-agent-acp',
    runtime: '@anthropic-ai/claude-agent-sdk',
  },
  codex: { adapter: '@agentclientprotocol/codex-acp', runtime: '@openai/codex' },
} as const;
const EXACT = /^\d+\.\d+\.\d+$/;

const ManifestSchema = z.looseObject({
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
});
const MetaSchema = z.object({
  runtime: z.object({ package: z.string(), version: z.string() }),
  adapter: z.object({ package: z.string(), version: z.string() }),
});

function readManifest(path: string) {
  return ManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** The runtime versions a release publishes, from the publishing script itself. */
function publishedRuntimeVersions(): Record<keyof typeof PROVIDERS, string> {
  const directory = mkdtempSync(join(tmpdir(), 'ff-runtime-versions-'));
  try {
    writeFileSync(join(directory, 'package.json'), readFileSync(join(repository, 'package.json')));
    symlinkSync(join(repository, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const result = spawnSync(
      process.execPath,
      [join(repository, 'scripts', 'prepare-runtime-metadata.mjs')],
      { cwd: directory, encoding: 'utf8' }
    );
    if (result.status !== 0) {
      throw new Error(`prepare-runtime-metadata.mjs failed: ${result.stderr}`);
    }
    return z
      .object({
        factoryFactoryRuntimeVersions: z.object({ claude: z.string(), codex: z.string() }),
      })
      .parse(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')))
      .factoryFactoryRuntimeVersions;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const fromApp = createRequire(join(repository, 'package.json'));
const app = readManifest(join(repository, 'package.json'));
const runtimeVersions = publishedRuntimeVersions();
const providers = Object.entries(PROVIDERS).map(([tool, packages]) => {
  const adapterManifestPath = fromApp.resolve(`${packages.adapter}/package.json`);
  return {
    tool,
    ...packages,
    adapterManifest: readManifest(adapterManifestPath),
    runtimeVersion: runtimeVersions[tool as keyof typeof PROVIDERS],
  };
});

describe.each(providers.map((provider) => [provider.tool, provider] as const))(
  '%s',
  (tool, provider) => {
    const recording = join(recordings, tool, provider.runtimeVersion);
    const rerecord = `Record it: node scripts/record-upstream.mjs ${tool}, and commit src/backend/testing/fixtures/upstream/${tool}/${provider.runtimeVersion}/.`;

    it('has a recording of the runtime version a release publishes', () => {
      expect(
        existsSync(join(recording, 'meta.json')),
        `No recording of ${provider.runtime} ${provider.runtimeVersion}. ${rerecord}`
      ).toBe(true);
      expect(
        MetaSchema.parse(JSON.parse(readFileSync(join(recording, 'meta.json'), 'utf8'))).runtime
      ).toEqual({
        package: provider.runtime,
        version: provider.runtimeVersion,
      });
    });

    it('has a recording made with the installed adapter version', () => {
      const meta = existsSync(join(recording, 'meta.json'))
        ? MetaSchema.parse(JSON.parse(readFileSync(join(recording, 'meta.json'), 'utf8')))
        : undefined;
      expect(
        meta?.adapter,
        `No recording of ${provider.adapter} ${provider.adapterManifest.version} with ${provider.runtime} ${provider.runtimeVersion}. ${rerecord}`
      ).toEqual({ package: provider.adapter, version: provider.adapterManifest.version });
    });

    it('pins the adapter and its runtime exactly, so an install resolves only the recorded versions', () => {
      expect(app.dependencies?.[provider.adapter]).toBe(provider.adapterManifest.version);
      // The adapter pins its runtime, or the application does, at the resolved version.
      const adapterPin = provider.adapterManifest.dependencies?.[provider.runtime];
      const pin =
        adapterPin && EXACT.test(adapterPin) ? adapterPin : app.dependencies?.[provider.runtime];
      expect(pin).toBe(provider.runtimeVersion);
    });

    it('is not updated by Dependabot, which cannot record a session', () => {
      const npm = z
        .object({
          updates: z.array(
            z.looseObject({
              'package-ecosystem': z.string(),
              ignore: z.array(z.looseObject({ 'dependency-name': z.string() })).optional(),
            })
          ),
        })
        .parse(parse(readFileSync(join(repository, '.github', 'dependabot.yml'), 'utf8')))
        .updates.find((update) => update['package-ecosystem'] === 'npm');
      const ignored = new Set(npm?.ignore?.map((rule) => rule['dependency-name']));
      // A runtime the adapter pins itself is not one of the application's dependencies to update.
      const adapterPin = provider.adapterManifest.dependencies?.[provider.runtime];
      const pinnedHere = !(adapterPin && EXACT.test(adapterPin));
      expect(ignored.has(provider.adapter)).toBe(true);
      expect(ignored.has(provider.runtime)).toBe(pinnedHere);
    });
  }
);
