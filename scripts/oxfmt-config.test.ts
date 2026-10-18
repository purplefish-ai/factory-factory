import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'ff-oxfmt-config-'));
const binary = resolve('node_modules/.bin/oxfmt');

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function format(files: Record<string, string>) {
  const root = mkdtempSync(join(directory, 'fixture-'));
  copyFileSync('.oxfmtrc.json', join(root, '.oxfmtrc.json'));
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  const result = spawnSync(binary, ['--write', '.'], { cwd: root, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.stdout + result.stderr).not.toContain('error');
  expect(result.status).toBe(0);
  return (name: string) => readFileSync(join(root, name), 'utf8');
}

describe('repository Oxfmt configuration', () => {
  it('groups both project aliases after external dependencies without removing unused imports', () => {
    const result = format({
      'source.ts': [
        "import { schema } from '@/schema';",
        "import { Prisma } from '@prisma-gen/client';",
        "import { z } from 'zod';",
      ].join('\n'),
    })('source.ts');
    expect(result.indexOf("from 'zod'")).toBeLessThan(result.indexOf("from '@/schema'"));
    expect(result.indexOf("from 'zod'")).toBeLessThan(result.indexOf("from '@prisma-gen/client'"));
    expect(result).toContain('schema');
    expect(result).toContain('Prisma');
    expect(result).toContain('z');
  });

  it('preserves side effect import execution order', () => {
    const result = format({
      'source.ts': "import './z-polyfill';\nimport './a-initializer';\nimport './m-style.css';\n",
    })('source.ts');
    expect(result).toBe(
      "import './z-polyfill';\nimport './a-initializer';\nimport './m-style.css';\n"
    );
  });

  it('formats source, JSON and CSS while excluding generated files and the lockfile', () => {
    const files = {
      'source.ts': 'export const value = {nested: "text"};',
      'source.json': '{"value":true}',
      'source.css': '.example{color:red}',
      'prisma/generated/source.ts': 'generated sentinel that is not TypeScript',
      'pnpm-lock.yaml': 'unformatted:    lockfile',
    };
    const result = format(files);
    expect(result('source.ts')).toBe("export const value = { nested: 'text' };\n");
    expect(result('source.json')).toBe('{ "value": true }\n');
    expect(result('source.css')).toContain('  color: red;');
    expect(result('prisma/generated/source.ts')).toBe(files['prisma/generated/source.ts']);
    expect(result('pnpm-lock.yaml')).toBe(files['pnpm-lock.yaml']);
  });

  it('wraps Markdown prose at 80 columns and preserves fenced code', () => {
    const code = 'const value={unformatted:"text"};';
    const result = format({
      'document.md': `${'Markdown prose '.repeat(20)}\n\n\u0060\u0060\u0060ts\n${code}\n\u0060\u0060\u0060\n`,
    })('document.md');
    expect(
      result
        .trimEnd()
        .split('\n')
        .every((line) => line.length <= 80)
    ).toBe(true);
    expect(result).toContain(code);
  });
});
