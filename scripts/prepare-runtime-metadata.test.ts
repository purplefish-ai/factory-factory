import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ff-runtime-metadata-'));
  temporaryDirectories.push(root);
  const writePackage = (relative: string, data: unknown) => {
    mkdirSync(join(root, relative), { recursive: true });
    writeFileSync(join(root, relative, 'package.json'), JSON.stringify(data));
  };
  writePackage('', {
    name: 'factory-factory',
    version: '0.5.4',
    dependencies: { '@anthropic-ai/claude-agent-sdk': '99.0.0' },
  });
  writePackage('node_modules/@anthropic-ai/claude-agent-sdk', { version: '99.0.0' });
  writePackage('node_modules/@agentclientprotocol/claude-agent-acp', { version: '1.0.0' });
  writePackage(
    'node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk',
    { version: '0.3.312' }
  );
  writePackage('node_modules/@agentclientprotocol/codex-acp', { version: '1.0.0' });
  writePackage('node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex', {
    version: '0.165.0',
  });
  return { root, writePackage };
}

it('stamps the publishing manifest with adapter-resolved runtime versions', () => {
  const { root } = fixture();
  const result = spawnSync(process.execPath, [resolve('scripts/prepare-runtime-metadata.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const manifest = z
    .object({
      name: z.string(),
      version: z.string(),
      dependencies: z.record(z.string(), z.string()),
      factoryFactoryRuntimeVersions: z.object({ claude: z.string(), codex: z.string() }),
    })
    .parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  expect(manifest).toEqual({
    name: 'factory-factory',
    version: '0.5.4',
    dependencies: { '@anthropic-ai/claude-agent-sdk': '99.0.0' },
    factoryFactoryRuntimeVersions: { claude: '0.3.312', codex: '0.165.0' },
  });
});

it('fails publishing without writing partial metadata when a runtime cannot be resolved', () => {
  const { root } = fixture();
  rmSync(join(root, 'node_modules/@agentclientprotocol/codex-acp'), { recursive: true });
  const before = readFileSync(join(root, 'package.json'), 'utf8');
  const result = spawnSync(process.execPath, [resolve('scripts/prepare-runtime-metadata.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('@agentclientprotocol/codex-acp');
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
  expect(existsSync(join(root, '.package.json.runtime-metadata-backup'))).toBe(false);
});

it('restores the exact original manifest after repeated preparation and cleanup', () => {
  const { root } = fixture();
  const manifestPath = join(root, 'package.json');
  const original = Buffer.from('{\r\n\t"name":"factory-factory", "version":"0.5.4"\r\n}');
  writeFileSync(manifestPath, original);
  for (let attempt = 0; attempt < 2; attempt++) {
    const prepared = spawnSync(
      process.execPath,
      [resolve('scripts/prepare-runtime-metadata.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
      }
    );
    expect(prepared.status, prepared.stderr).toBe(0);
  }
  // A failed retry after an interrupted pack must leave the original recoverable.
  rmSync(join(root, 'node_modules/@agentclientprotocol/codex-acp'), { recursive: true });
  const failed = spawnSync(process.execPath, [resolve('scripts/prepare-runtime-metadata.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain('@agentclientprotocol/codex-acp');
  for (let attempt = 0; attempt < 2; attempt++) {
    const restored = spawnSync(
      process.execPath,
      [resolve('scripts/restore-runtime-metadata.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
      }
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect(readFileSync(manifestPath)).toEqual(original);
    expect(existsSync(join(root, '.package.json.runtime-metadata-backup'))).toBe(false);
  }
});

it('keeps the original recoverable if restoring the manifest fails', () => {
  const { root } = fixture();
  const manifestPath = join(root, 'package.json');
  const original = readFileSync(manifestPath);
  const prepared = spawnSync(process.execPath, [resolve('scripts/prepare-runtime-metadata.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(prepared.status, prepared.stderr).toBe(0);
  rmSync(manifestPath);
  mkdirSync(manifestPath);
  const failed = spawnSync(process.execPath, [resolve('scripts/restore-runtime-metadata.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(failed.status).not.toBe(0);
  expect(readFileSync(join(root, '.package.json.runtime-metadata-backup'))).toEqual(original);
  rmSync(manifestPath, { recursive: true });
  const restored = spawnSync(process.execPath, [resolve('scripts/restore-runtime-metadata.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(restored.status, restored.stderr).toBe(0);
  expect(readFileSync(manifestPath)).toEqual(original);
});

it('packs runtime metadata while restoring the checkout and excluding recovery files', () => {
  const { root, writePackage } = fixture();
  const { files, scripts } = z
    .object({ files: z.array(z.string()), scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(resolve('package.json'), 'utf8')));
  writePackage('', {
    name: 'factory-factory',
    version: '0.5.4',
    files,
    scripts: { prepack: scripts.prepack, postpack: scripts.postpack },
  });
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/artifact.txt'), 'artifact');
  mkdirSync(join(root, 'scripts'));
  for (const script of [
    'check-production-artifact.mjs',
    'prepare-runtime-metadata.mjs',
    'restore-runtime-metadata.mjs',
  ]) {
    if (existsSync(resolve('scripts', script))) {
      copyFileSync(resolve('scripts', script), join(root, 'scripts', script));
    }
  }
  symlinkSync(resolve('node_modules/zod'), join(root, 'node_modules/zod'), 'dir');
  const original = readFileSync(join(root, 'package.json'));
  const packed = spawnSync('pnpm', ['pack'], { cwd: root, encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  expect(readFileSync(join(root, 'package.json'))).toEqual(original);
  const archive = join(root, 'factory-factory-0.5.4.tgz');
  const manifest = spawnSync('tar', ['-xOf', archive, 'package/package.json'], {
    encoding: 'utf8',
  });
  expect(manifest.status, manifest.stderr).toBe(0);
  expect(
    z
      .object({
        factoryFactoryRuntimeVersions: z.object({ claude: z.string(), codex: z.string() }),
      })
      .parse(JSON.parse(manifest.stdout)).factoryFactoryRuntimeVersions
  ).toEqual({ claude: '0.3.312', codex: '0.165.0' });
  const contents = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  expect(contents.status, contents.stderr).toBe(0);
  expect(contents.stdout.trim().split('\n').sort()).toEqual([
    'package/dist/artifact.txt',
    'package/package.json',
  ]);
}, 20_000);

it('reads runtime metadata when package exports hide package.json', () => {
  const { root, writePackage } = fixture();
  const relative =
    'node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk';
  writePackage(relative, {
    name: '@anthropic-ai/claude-agent-sdk',
    version: '0.3.312',
    exports: { '.': './sdk.mjs' },
  });
  writeFileSync(join(root, relative, 'sdk.mjs'), 'export {};');
  const result = spawnSync(process.execPath, [resolve('scripts/prepare-runtime-metadata.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(
    z
      .object({ factoryFactoryRuntimeVersions: z.object({ claude: z.string() }) })
      .parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))
      .factoryFactoryRuntimeVersions.claude
  ).toBe('0.3.312');
});
