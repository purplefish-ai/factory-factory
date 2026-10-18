import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface AstNode {
  type: string;
  value?: string;
  nodes?: AstNode[];
}
interface Braces {
  parse(pattern: string): AstNode;
  compile(pattern: string | AstNode): string;
  expand(pattern: string | AstNode): string[];
  stringify(ast: AstNode): string;
}

const require = createRequire(import.meta.url);
const aliasRequire = createRequire(require.resolve('tsc-alias'));
const chokidarRequire = createRequire(aliasRequire.resolve('chokidar'));
const globbyRequire = createRequire(aliasRequire.resolve('globby'));
const fastGlobRequire = createRequire(globbyRequire.resolve('fast-glob'));
const micromatchRequire = createRequire(fastGlobRequire.resolve('micromatch'));
const consumers = [
  ['chokidar', chokidarRequire.resolve('braces')],
  ['micromatch', micromatchRequire.resolve('braces')],
] as const;

function nestedAst(depth: number): AstNode {
  let node: AstNode = { type: 'text', value: 'x' };
  for (let index = 0; index < depth; index++) {
    node = { type: 'paren', nodes: [node] };
  }
  return { type: 'root', nodes: [node] };
}

describe.each(consumers)('braces depth mitigation through %s', (_consumer, path) => {
  const braces = require(path) as Braces;

  it('keeps ordinary glob expansion and compilation working', () => {
    expect(braces.expand('file.{ts,tsx}')).toEqual(['file.ts', 'file.tsx']);
    expect(braces.compile('file.{ts,tsx}')).toBe('file.(ts|tsx)');
    expect(braces.stringify(braces.parse('file.{ts,tsx}'))).toBe('file.{ts,tsx}');
  });

  it.each([
    ['braces', '{', '}'],
    ['parentheses', '(', ')'],
  ])('rejects deeply nested %s below the input character limit', (_name, open, close) => {
    const source = `${open.repeat(4000)}x${close.repeat(4000)}`;
    expect(source.length).toBeLessThan(10_000);
    expect(() => braces.parse(source)).toThrow(SyntaxError);
    expect(() => braces.parse(source)).toThrow('Nesting depth exceeds maximum');
  });

  it.each(['compile', 'expand', 'stringify'] as const)(
    'bounds recursion in %s even for a pre-parsed AST',
    (method) => {
      expect(() => braces[method](nestedAst(4000))).toThrow(SyntaxError);
      expect(() => braces[method](nestedAst(4000))).toThrow('Nesting depth exceeds maximum');
    }
  );
});
