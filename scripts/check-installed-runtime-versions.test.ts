import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** An installed package whose Codex adapter resolves `codexRuntime`. */
function installed(codexRuntime: string) {
  const root = mkdtempSync(join(tmpdir(), 'ff-installed-runtimes-'));
  temporaryDirectories.push(root);
  const writePackage = (relative: string, data: unknown) => {
    mkdirSync(join(root, relative), { recursive: true });
    writeFileSync(join(root, relative, 'package.json'), JSON.stringify(data));
  };
  writePackage('', {
    name: 'factory-factory',
    version: '1.0.0',
    factoryFactoryRuntimeVersions: { claude: '0.3.312', codex: '0.166.0' },
  });
  writePackage('node_modules/@agentclientprotocol/claude-agent-acp', { version: '0.99.1' });
  writePackage(
    'node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk',
    { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.312' }
  );
  writePackage('node_modules/@agentclientprotocol/codex-acp', { version: '2.6.0' });
  writePackage('node_modules/@openai/codex', { name: '@openai/codex', version: codexRuntime });
  return root;
}

function check(root: string) {
  return spawnSync(
    process.execPath,
    [resolve('scripts/check-installed-runtime-versions.mjs'), root],
    { encoding: 'utf8' }
  );
}

it('passes when each adapter resolves the runtime version the package publishes', () => {
  const result = check(installed('0.166.0'));
  expect(result.status, result.stderr).toBe(0);
});

it('fails naming both versions when an install resolves another runtime', () => {
  const result = check(installed('0.166.1'));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    '@agentclientprotocol/codex-acp resolves @openai/codex 0.166.1, but the package publishes codex 0.166.0'
  );
});
