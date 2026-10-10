import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type BraceNode = {
  type: string;
  value?: string;
  nodes?: BraceNode[];
  parent?: BraceNode;
};

type Braces = {
  parse: (input: string, options?: Record<string, unknown>) => BraceNode;
  compile: (input: string | BraceNode) => string;
  stringify: (input: string | BraceNode, options?: Record<string, unknown>) => string;
  expand: (input: string | BraceNode) => string[];
};

// Resolve the installed transitive packages through their actual build consumers.
const require = createRequire(import.meta.url);
const aliasRequire = createRequire(require.resolve('tsc-alias'));
const globRequire = createRequire(aliasRequire.resolve('globby'));
const fastGlobRequire = createRequire(globRequire.resolve('fast-glob'));
const micromatchRequire = createRequire(fastGlobRequire.resolve('micromatch'));
const braces: Braces = micromatchRequire('braces');

function nestedAst(depth: number): BraceNode {
  const root: BraceNode = { type: 'root', nodes: [] };
  let parent = root;
  for (let i = 0; i < depth; i++) {
    const node: BraceNode = { type: 'paren', nodes: [], parent };
    parent.nodes?.push(node);
    parent = node;
  }
  parent.nodes?.push({ type: 'text', value: 'x', parent });
  return root;
}

describe('braces security patch', () => {
  it.each(['parse', 'compile', 'stringify', 'expand'] as const)(
    '%s rejects excessive brace nesting before recursive traversal',
    (method) => {
      const pattern = `${'{'.repeat(4000)}x${'}'.repeat(4000)}`;
      expect(() => braces[method](pattern)).toThrow(SyntaxError);
    }
  );

  it.each(['parse', 'compile', 'stringify', 'expand'] as const)(
    '%s rejects excessive parentheses nesting',
    (method) => {
      const pattern = `${'('.repeat(257)}x${')'.repeat(257)}`;
      expect(() => braces[method](pattern)).toThrow(SyntaxError);
    }
  );

  it('counts brace and parentheses nesting together', () => {
    const pattern = `${'{('.repeat(129)}x${')}'.repeat(129)}`;
    expect(() => braces.parse(pattern)).toThrow(SyntaxError);
  });

  it.each(['compile', 'stringify', 'expand'] as const)(
    '%s rejects excessive nesting in caller-supplied ASTs',
    (method) => {
      expect(() => braces[method](nestedAst(257))).toThrow(SyntaxError);
    }
  );

  it('preserves nesting at the supported boundary', () => {
    const pattern = `${'('.repeat(256)}x${')'.repeat(256)}`;
    expect(braces.compile(pattern)).toBe(pattern);
    expect(braces.stringify(pattern)).toBe(pattern);
    expect(braces.expand(pattern)).toEqual([pattern]);
  });

  it.each([
    { name: 'escaped braces', pattern: '\\{'.repeat(400) },
    { name: 'escaped parentheses', pattern: '\\('.repeat(400) },
    { name: 'brackets', pattern: `[${'{('.repeat(400)}]` },
    { name: 'quotes', pattern: `"${'{('.repeat(400)}"` },
  ])('does not count literal delimiters in $name as nesting', ({ pattern }) => {
    expect(braces.stringify(pattern, { keepEscaping: true, keepQuotes: true })).toBe(pattern);
  });

  it('preserves ordinary brace expansion and ranges', () => {
    expect(braces.compile('file-{a,b}-{1..3}')).toBe('file-(a|b)-([1-3])');
    expect(braces.expand('file-{a,b}-{1..2}')).toEqual([
      'file-a-1',
      'file-a-2',
      'file-b-1',
      'file-b-2',
    ]);
  });
});
