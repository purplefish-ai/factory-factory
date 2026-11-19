import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTypedVitestMocks } from './typed-vitest-mocks';

describe('typed Vitest mock codemod', () => {
  let root: string;

  function put(path: string, source: string) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }

  function read(path: string) {
    return readFileSync(join(root, path), 'utf8');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ff-typed-mocks-'));
    put(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          paths: { '@/*': ['./src/*'], '@prisma-gen/*': ['./prisma/generated/*'] },
        },
      })
    );
    put('src/module.ts', 'export const value = 1;');
    put('prisma/generated/client.ts', 'export const client = {};');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('previews and writes only concrete workspace mock targets, preserving trivia', () => {
    const file = 'src/example.test.tsx';
    const source = [
      '\uFEFFimport { vi } from "vitest";',
      "vi.mock(/* keep */ './module' /* keep */,);",
      'vi.doMock("@/module");',
      'vi.mock("@prisma-gen/client");',
      'const view = <div />;',
      '',
    ].join('\r\n');
    put(file, source);
    put('src/unselected.test.ts', source.replace('const view = <div />;', ''));
    const preview = runTypedVitestMocks(root, [file, file]);
    expect(preview).toContain(`${file}:2:`);
    expect(preview).toContain("'./module' -> import('./module')");
    expect(preview).toContain('3 mocks in 1 file');
    expect(read(file)).toBe(source);

    const result = runTypedVitestMocks(root, ['--write', file]);
    expect(result).toContain('3 mocks in 1 file');
    expect(read(file)).toBe(
      source
        .replace("'./module'", "import('./module')")
        .replace('"@/module"', 'import("@/module")')
        .replace('"@prisma-gen/client"', 'import("@prisma-gen/client")')
    );
    expect(read('src/unselected.test.ts')).toContain('vi.doMock("@/module")');
    expect(runTypedVitestMocks(root, ['--write', file])).toContain('0 mocks in 0 files');
  });

  it('leaves imports, runtime expressions, and mocks outside the supported scope intact', () => {
    const files = {
      'src/skip.test.ts': [
        'import { vi, vi as aliased } from "vitest";',
        'import * as vitest from "vitest";',
        'vi.mock(import("./module"));',
        'vi.mock("./module", () => ({}));',
        'vi.doMock("./module", { spy: true });',
        'vi.mock("node:fs");',
        'vi.mock("vitest");',
        'vi.mock("./module.ts");',
        'vi.doMock("@/module.ts");',
        'vi.mock("./unresolved");',
        'vi.mock("@/unresolved");',
        'vi.mock("../node_modules/dependency");',
        'vi.mock("./types");',
        'vi.mock(path);',
        `vi.mock(\`./\${path}\`);`,
        'vi["mock"]("./module");',
        'vi?.mock("./module");',
        'vi.mock?.("./module");',
        'aliased.mock("./module");',
        'vitest.vi.mock("./module");',
        'function use(vi: object) { vi.mock("./module"); }',
        '{ const vi = other; vi.doMock("./module"); }',
        'vi.unmock("./module");',
        '// vi.mock("./module");',
        'const text = "vi.mock(\'./module\')";',
      ].join('\n'),
      'src/third-party.test.ts': 'import { vi } from "other"; vi.mock("./module");',
      'src/type-import.test.ts': 'import type { vi } from "vitest"; vi.mock("./module");',
      'src/type-specifier.test.ts': 'import { type vi } from "vitest"; vi.mock("./module");',
      'src/globals.test.ts': 'vi.mock("./module");',
      'src/javascript.test.js': 'import { vi } from "vitest"; vi.mock("./module");',
    };
    put('node_modules/dependency/index.ts', 'export const value = 0;');
    put('src/types.d.ts', 'export declare const value: number;');
    for (const [path, source] of Object.entries(files)) {
      put(path, source);
    }

    expect(runTypedVitestMocks(root, ['--write', ...Object.keys(files)])).toContain(
      '0 mocks in 0 files'
    );
    for (const [path, source] of Object.entries(files)) {
      expect(read(path), path).toBe(source);
    }
  });

  it('requires explicit input files', () => {
    expect(() => runTypedVitestMocks(root, [])).toThrow('Usage:');
    expect(() => runTypedVitestMocks(root, ['src'])).toThrow('Expected a file');
  });
});
