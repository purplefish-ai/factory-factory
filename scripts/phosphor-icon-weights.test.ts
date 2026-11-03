import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, parseAst, resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { phosphorWeights, stripPhosphorWeights } from './phosphor-icon-weights';

const packageDist = dirname(
  dirname(fileURLToPath(import.meta.resolve('@phosphor-icons/react/dist/csr/Check')))
);

function definition(weights: readonly string[]) {
  return [
    'import * as e from "react";',
    'const a = /* @__PURE__ */ new Map([',
    weights
      .map(
        (weight) =>
          `  ["${weight}", /* @__PURE__ */ e.createElement(e.Fragment, null, e.createElement("path", { d: "${weight}-path" }))]`
      )
      .join(',\n'),
    ']);',
    'export {',
    '  a as default',
    '};',
  ].join('\n');
}

function retainedWeights(code: string) {
  const declaration = parseAst(code).body[1];
  if (declaration?.type !== 'VariableDeclaration') {
    throw new Error('missing declaration');
  }
  const init = declaration.declarations[0]?.init;
  const list = init?.type === 'NewExpression' ? init.arguments[0] : undefined;
  if (list?.type !== 'ArrayExpression') {
    throw new Error('missing Map entries');
  }
  return list.elements.map((element) => {
    const key = element?.type === 'ArrayExpression' ? element.elements[0] : undefined;
    return key?.type === 'Literal' ? key.value : undefined;
  });
}

describe('stripPhosphorWeights', () => {
  it('keeps only regular for icons without allowlisted weights', () => {
    const code = stripPhosphorWeights(definition(phosphorWeights), 'Gear');
    expect(retainedWeights(code)).toEqual(['regular']);
    expect(code).toContain('"regular-path"');
    expect(code).not.toContain('thin-path');
    expect(code).toMatch(/export \{\s*a as default\s*\};$/);
  });

  it('keeps allowlisted fill and duotone weights per icon', () => {
    expect(retainedWeights(stripPhosphorWeights(definition(phosphorWeights), 'Wrench'))).toEqual([
      'regular',
      'fill',
    ]);
    expect(retainedWeights(stripPhosphorWeights(definition(phosphorWeights), 'Leaf'))).toEqual([
      'regular',
      'duotone',
    ]);
  });

  it.each([
    ['a missing weight', definition(phosphorWeights.filter((weight) => weight !== 'thin'))],
    ['an unknown weight', definition([...phosphorWeights, 'heavy'])],
    ['a duplicated weight', definition([...phosphorWeights, 'regular'])],
    ['a non-Map export', definition(phosphorWeights).replace('new Map(', 'new Set(')],
    ['an extra statement', `${definition(phosphorWeights)}\nexport const extra = 1;`],
    ['a different default export', definition(phosphorWeights).replace('a as default', 'a as b')],
    ['a computed weight key', definition(phosphorWeights).replace('["thin"', '[`thin`')],
  ])('fails loudly on %s instead of shipping an empty icon', (_label, code) => {
    expect(() => stripPhosphorWeights(code, 'Check')).toThrow(
      /Unexpected Phosphor icon definition shape for Check/
    );
  });

  it('understands every definition module in the installed package', () => {
    const definitions = readdirSync(join(packageDist, 'defs')).filter((file) =>
      file.endsWith('.es.js')
    );
    expect(definitions.length).toBeGreaterThan(1000);
    for (const file of definitions) {
      const icon = file.replace(/\.es\.js$/, '');
      const code = readFileSync(join(packageDist, 'defs', file), 'utf8');
      expect(retainedWeights(stripPhosphorWeights(code, icon))).toContain('regular');
      // The plugin maps defs/<Name> to the allowlist name used by csr/<Name> imports.
      expect(readFileSync(join(packageDist, 'csr', file), 'utf8')).toContain(
        `from "../defs/${file}"`
      );
    }
  });
});

describe('phosphorIconWeights plugin', () => {
  it('is registered for builds and dependency pre-bundling', async () => {
    const config = await resolveConfig({ configFile: resolve('vite.config.ts') }, 'serve');
    const isWeightPlugin = (plugin: unknown) =>
      typeof plugin === 'object' &&
      plugin !== null &&
      'name' in plugin &&
      typeof plugin.name === 'string' &&
      plugin.name.startsWith('phosphor-icon-weights:');
    expect(config.plugins.some(isWeightPlugin)).toBe(true);
    const optimizerPlugins = config.optimizeDeps.rolldownOptions?.plugins;
    expect(Array.isArray(optimizerPlugins) && optimizerPlugins.some(isWeightPlugin)).toBe(true);
  });

  it('strips unused weights from a production build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-phosphor-weights-'));
    try {
      const icon = fileURLToPath(import.meta.resolve('@phosphor-icons/react/dist/csr/Check'));
      writeFileSync(
        join(root, 'entry.js'),
        `import { CheckIcon } from ${JSON.stringify(icon)}; globalThis.icon = CheckIcon;`
      );
      const output = await build({
        configFile: resolve('vite.config.ts'),
        root,
        publicDir: false,
        logLevel: 'silent',
        build: {
          write: false,
          minify: false,
          rolldownOptions: { input: join(root, 'entry.js'), external: ['react'] },
        },
      });
      const code = (Array.isArray(output) ? output : [output])
        .flatMap((result) => ('output' in result ? result.output : []))
        .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
        .join('\n');
      // Check's regular path is retained; its thin and duotone paths are dropped.
      expect(code).toContain('M229.66,77.66l-128,128');
      expect(code).not.toContain('M226.83,74.83l-128,128');
      expect(code).not.toContain('opacity: "0.2"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
