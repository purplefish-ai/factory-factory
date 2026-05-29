import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../../../scripts/check-prisma-generated-drift.mjs', import.meta.url)
);

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
}

describe('check-prisma-generated-drift script', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('flags untracked generated files even when prisma/generated is gitignored', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ff-prisma-generated-drift-'));

    run('git', ['init'], tempRoot);
    run('git', ['config', 'user.name', 'Test User'], tempRoot);
    run('git', ['config', 'user.email', 'test@example.com'], tempRoot);

    writeFileSync(join(tempRoot, '.gitignore'), 'prisma/generated/\n', 'utf8');
    writeFileSync(join(tempRoot, 'README.md'), 'fixture\n', 'utf8');
    run('git', ['add', '.gitignore', 'README.md'], tempRoot);
    run('git', ['commit', '-m', 'Initial commit'], tempRoot);

    const generatedFile = join(tempRoot, 'prisma', 'generated', 'client.ts');
    mkdirSync(dirname(generatedFile), { recursive: true });
    writeFileSync(generatedFile, 'export const generated = true;\n', 'utf8');

    const result = spawnSync('node', [scriptPath], {
      cwd: tempRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Generated Prisma client is out of sync.');
    expect(result.stderr).toContain('- prisma/generated/client.ts');
  });
});
