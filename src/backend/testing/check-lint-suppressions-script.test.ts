import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/check-lint-suppressions.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCheck(source: string, relativeFile = 'src/example.ts') {
  const root = mkdtempSync(join(tmpdir(), 'ff-lint-suppressions-'));
  roots.push(root);
  const file = join(root, relativeFile);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, source);
  return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
}

describe('inline lint suppression policy', () => {
  it.each([
    '// biome-ignore lint/style/noNonNullAssertion: temporary',
    '/* biome-ignore-all lint: temporary */',
    '// oxlint-disable-next-line no-console',
    '/* oxlint-disable */',
    '// eslint-disable-next-line no-console',
    '{/* eslint-disable no-console */}',
    '// oxfmt-ignore',
    '// prettier-ignore',
  ])('rejects %s outside generated code', (source) => {
    const result = runCheck(source);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/example.ts');
  });

  it('permits ordinary comments', () => {
    expect(runCheck('// Keep the console output for the CLI.').status).toBe(0);
  });

  it('does not treat string fixtures as suppression comments', () => {
    expect(runCheck('export const fixture = "// oxlint-disable";').status).toBe(0);
  });

  it('permits generated code', () => {
    expect(runCheck('// oxlint-disable', 'prisma/generated/client.ts').status).toBe(0);
  });

  it.each(['biome-ignore lint/suspicious/noDuplicateProperties: needed', 'oxfmt-ignore'])(
    'rejects CSS directives after a string comment opener: %s',
    (directive) => {
      const source = `.example::before { content: "/*"; }\n/* ${directive} */\n.example { color: red; color: blue; }`;
      expect(runCheck(source, 'src/example.css').status).toBe(1);
    }
  );

  it('permits directive text inside CSS strings', () => {
    expect(
      runCheck('.example::before { content: "/* oxfmt-ignore */"; }', 'src/example.css').status
    ).toBe(0);
  });

  it('rejects real CSS suppression comments', () => {
    expect(runCheck('/* oxfmt-ignore */\n.example { color: red; }', 'src/example.css').status).toBe(
      1
    );
  });

  it.each([
    String.raw`.example { --quote: \"; }`,
    String.raw`.example { background: url(quote\".png); }`,
  ])('rejects directives after CSS escapes outside strings: %s', (prefix) => {
    expect(
      runCheck(`${prefix}\n/* oxfmt-ignore */\n.example { color: red; }`, 'src/example.css').status
    ).toBe(1);
  });

  it('rejects JSON lint suppression comments', () => {
    expect(
      runCheck(
        '/* biome-ignore lint/correctness/noDuplicateObjectKeys: needed */\n{ "key": 1, "key": 2 }',
        'src/example.json'
      ).status
    ).toBe(1);
  });

  it('permits directive text inside JSON strings', () => {
    expect(runCheck('{ "example": "// biome-ignore lint: text" }', 'src/example.json').status).toBe(
      0
    );
  });

  it('checks configuration files at the root', () => {
    expect(runCheck('// oxlint-disable-next-line', 'vite.config.ts').status).toBe(1);
  });

  it.each([
    ['public/example.html', '<!-- prettier-ignore -->\n<div    class = "example"></div>'],
    ['index.html', '<!-- oxfmt-ignore -->\n<div    class = "example"></div>'],
    ['.github/workflows/demo.yml', '# prettier-ignore\nname: example'],
    ['docs/example.md', '<!-- prettier-ignore -->\nAn example paragraph.'],
    ['.planning/example.md', '<!-- oxfmt-ignore -->\nAn example paragraph.'],
  ])('rejects formatter directives in %s', (file, source) => {
    expect(runCheck(source, file).status).toBe(1);
  });

  it.each([
    ['docs/example.md', '```html\n<!-- prettier-ignore -->\n```'],
    ['docs/example.md', 'Use `<!-- prettier-ignore -->` in this example.'],
    ['public/example.html', '<div data-example="<!-- prettier-ignore -->"></div>'],
    ['.github/workflows/demo.yml', 'example: "# prettier-ignore"'],
    ['.github/workflows/demo.yml', 'example: |\n  # prettier-ignore\n  literal text'],
  ])('permits literal formatter directive examples in %s', (file, source) => {
    expect(runCheck(source, file).status).toBe(0);
  });

  it('rejects an HTML directive that hides formatting from Oxfmt', () => {
    const source = '<!-- prettier-ignore -->\n<div    data-example = "value"></div>\n';
    const formatted = spawnSync(
      resolve('node_modules/.bin/oxfmt'),
      ['--stdin-filepath', 'index.html'],
      {
        input: source,
        encoding: 'utf8',
      }
    );
    expect(formatted.error).toBeUndefined();
    expect(formatted.status).toBe(0);
    expect(formatted.stdout).toContain('<div    data-example = "value"></div>');
    expect(runCheck(source, 'public/example.html').status).toBe(1);
  });

  it('rejects YAML directives following apostrophes in plain scalars', () => {
    expect(
      runCheck("name: Joe's task\n# prettier-ignore\non: [push]\n", '.github/workflows/demo.yml')
        .status
    ).toBe(1);
  });

  it.each(['script', 'style'])('preserves raw %s text after a closing tag prefix', (tag) => {
    const source = `<${tag}>literal </${tag}ure><!-- prettier-ignore --></${tag}>`;
    expect(runCheck(source, 'public/example.html').status).toBe(0);
    expect(runCheck(`${source}\n<!-- prettier-ignore -->`, 'public/example.html').status).toBe(1);
  });

  it('rejects real Markdown comments following unmatched backtick runs', () => {
    expect(
      runCheck('Example ``` unmatched\n<!-- prettier-ignore -->\n` trailing', 'docs/example.md')
        .status
    ).toBe(1);
  });

  it('permits Markdown examples with matching complete backtick runs', () => {
    expect(
      runCheck('Example `` literal ` <!-- prettier-ignore --> `` trailing', 'docs/example.md')
        .status
    ).toBe(0);
  });

  it('checks end-to-end tests for suppressions', () => {
    expect(runCheck('// oxlint-disable', 'e2e/example.spec.ts').status).toBe(1);
  });
});
