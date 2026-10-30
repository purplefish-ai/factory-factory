#!/usr/bin/env node
/** Verify a built desktop app without a global Node or Claude installation. */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function findPackagedApp() {
  const release = resolve('release');
  for (const entry of readdirSync(release, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(release, entry.name);
    if (process.platform === 'darwin') {
      const app = join(directory, 'Factory Factory.app', 'Contents');
      if (existsSync(join(app, 'MacOS', 'Factory Factory'))) {
        return [join(app, 'MacOS', 'Factory Factory'), join(app, 'Resources')];
      }
    } else {
      const executable = join(
        directory,
        process.platform === 'win32' ? 'Factory Factory.exe' : 'factory-factory'
      );
      if (existsSync(executable)) {
        return [executable, join(directory, 'resources')];
      }
    }
  }
  throw new Error('No packaged desktop app found in release/. Build it first.');
}

const [runtime, resources] = process.argv.length > 2 ? process.argv.slice(2) : findPackagedApp();
if (!(runtime && resources)) {
  throw new Error('Usage: node scripts/check-packaged-claude.mjs [executable resources-directory]');
}
const backend = join(resolve(resources), 'app.asar.unpacked', 'dist', 'src', 'backend');
const moduleUrl = (path) => JSON.stringify(pathToFileURL(join(backend, path)).href);
const configDirectory = mkdtempSync(join(tmpdir(), 'ff-packaged-claude-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !['path', 'claude_code_executable'].includes(key.toLowerCase())
  )
);

try {
  const { stdout } = await execFileAsync(
    resolve(runtime),
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { getBundledClaudeCommand } from ${moduleUrl('lib/claude-cli-command.js')};
    import { resolveProviderAcpSpawnCommand } from ${moduleUrl('services/session/service/acp/acp-runtime-spawn.js')};
    import { fetchClaudeModelCatalogFromAcp } from ${moduleUrl('services/session/service/acp/claude-model-catalog-loader.js')};

    const command = getBundledClaudeCommand(['--version']);
    assert.equal(command.command, process.execPath);
    const version = execFileSync(command.command, command.args, { encoding: 'utf8', timeout: 15000 });
    assert.match(version, /\\d+\\.\\d+\\.\\d+.*Claude Code/);
    console.log('Bundled Claude: ' + version.trim());

    const adapter = resolveProviderAcpSpawnCommand('CLAUDE');
    assert.equal(adapter.command, process.execPath);
    assert.ok(adapter.args[0].includes('app.asar.unpacked'));
    try {
      const models = await fetchClaudeModelCatalogFromAcp();
      assert.ok(models.length > 0);
      console.log('Packaged ACP catalog passed with an empty PATH (' + models.length + ' models).');
    } catch (error) {
      // CI has no account credentials. An explicit authentication requirement
      // still proves the real adapter and catalog launch path initialized.
      if (!/authentication required|not authenticated|not logged in|login required/i.test(error.message)) {
        throw error;
      }
      console.log('Packaged ACP catalog launched with an empty PATH; sign-in required for models.');
    }
  `,
    ],
    {
      env: {
        ...env,
        PATH: '',
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_CONFIG_DIR: configDirectory,
        BROWSER: 'none',
      },
      timeout: 90_000,
    }
  );
  process.stdout.write(stdout);
} finally {
  rmSync(configDirectory, { recursive: true, force: true });
}
