import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
});

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
