import { type Plugin, parseAst } from 'vite';

/** Every weight a Phosphor icon definition module ships. */
export const phosphorWeights = ['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const;
export type PhosphorWeight = (typeof phosphorWeights)[number];

/**
 * Non-default weights each icon may render, keyed by its `dist/csr/<Name>` module name.
 * `regular` (the IconBase default) is always kept. The icon policy test in
 * `src/lib/icon-library.test.ts` fails when source uses a weight not listed here,
 * and when an entry here is no longer used.
 */
export const phosphorWeightAllowlist: Readonly<
  Partial<Record<Exclude<PhosphorWeight, 'regular'>, readonly string[]>>
> = {
  fill: ['CheckCircle', 'Circle', 'Play', 'Square', 'Wrench'],
  duotone: [
    'Acorn',
    'Butterfly',
    'Cactus',
    'Clover',
    'Flower',
    'FlowerLotus',
    'Leaf',
    'Plant',
    'PottedPlant',
    'Sun',
    'Tree',
    'TreeEvergreen',
  ],
};

export function allowedPhosphorWeights(icon: string): ReadonlySet<PhosphorWeight> {
  return new Set<PhosphorWeight>([
    'regular',
    ...phosphorWeights.filter((weight) =>
      weight === 'regular' ? false : phosphorWeightAllowlist[weight]?.includes(icon)
    ),
  ]);
}

const definitionIdPattern =
  /[\\/]@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/]([A-Za-z0-9]+)\.es\.js$/;

function isPhosphorWeight(value: unknown): value is PhosphorWeight {
  return phosphorWeights.some((weight) => weight === value);
}

interface Span {
  start: number;
  end: number;
}

function locateWeightEntries(code: string) {
  const program = parseAst(code);
  const [imported, declaration, exported] = program.body;
  if (
    program.body.length !== 3 ||
    imported?.type !== 'ImportDeclaration' ||
    imported.source.value !== 'react' ||
    declaration?.type !== 'VariableDeclaration' ||
    declaration.kind !== 'const' ||
    declaration.declarations.length !== 1 ||
    exported?.type !== 'ExportNamedDeclaration' ||
    exported.declaration ||
    exported.source ||
    exported.specifiers.length !== 1
  ) {
    throw new Error('expected `import react; const x = new Map([...]); export { x as default }`');
  }
  const [declarator] = declaration.declarations;
  const [specifier] = exported.specifiers;
  const init = declarator?.init;
  if (
    declarator?.id.type !== 'Identifier' ||
    specifier?.local.type !== 'Identifier' ||
    specifier.local.name !== declarator.id.name ||
    specifier.exported.type !== 'Identifier' ||
    specifier.exported.name !== 'default' ||
    init?.type !== 'NewExpression' ||
    init.callee.type !== 'Identifier' ||
    init.callee.name !== 'Map' ||
    init.arguments.length !== 1 ||
    init.arguments[0]?.type !== 'ArrayExpression'
  ) {
    throw new Error('expected the default export to be `new Map([...])`');
  }
  const list = init.arguments[0];
  const entries = new Map<PhosphorWeight, Span>();
  for (const element of list.elements) {
    const key = element?.type === 'ArrayExpression' ? element.elements[0] : undefined;
    if (
      element?.type !== 'ArrayExpression' ||
      element.elements.length !== 2 ||
      key?.type !== 'Literal' ||
      !isPhosphorWeight(key.value) ||
      entries.has(key.value)
    ) {
      throw new Error('expected each Map entry to be a unique `[weight, element]` pair');
    }
    entries.set(key.value, { start: element.start, end: element.end });
  }
  const missing = phosphorWeights.filter((weight) => !entries.has(weight));
  if (missing.length > 0) {
    throw new Error(`missing weights: ${missing.join(', ')}`);
  }
  return { list: { start: list.start, end: list.end }, entries };
}

/** Drop the weights `icon` never renders from a Phosphor `dist/defs/<Name>.es.js` module. */
export function stripPhosphorWeights(code: string, icon: string): string {
  let located: ReturnType<typeof locateWeightEntries>;
  try {
    located = locateWeightEntries(code);
  } catch (error) {
    throw new Error(
      `Unexpected Phosphor icon definition shape for ${icon}: ${
        error instanceof Error ? error.message : String(error)
      }. Update scripts/phosphor-icon-weights.ts for the installed @phosphor-icons/react.`,
      { cause: error }
    );
  }
  const allowed = allowedPhosphorWeights(icon);
  const kept = [...located.entries]
    .filter(([weight]) => allowed.has(weight))
    .map(([, span]) => code.slice(span.start, span.end));
  return `${code.slice(0, located.list.start)}[\n  ${kept.join(',\n  ')}\n]${code.slice(located.list.end)}`;
}

function transformDefinition(code: string, id: string) {
  const icon = definitionIdPattern.exec(id.replace(/\?.*$/, ''))?.[1];
  return icon ? { code: stripPhosphorWeights(code, icon), map: null } : null;
}

const transformFilter = { id: /@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/]/ };

/**
 * Strip unused icon weights in builds, the dev server, and dependency pre-bundling.
 * The allowlist is part of the plugin names so changing it invalidates Vite's dep cache.
 */
export function phosphorIconWeights(): Plugin {
  const name = `phosphor-icon-weights:${JSON.stringify(phosphorWeightAllowlist)}`;
  return {
    name,
    config: () => ({
      optimizeDeps: {
        rolldownOptions: {
          plugins: [
            {
              name,
              transform: { filter: transformFilter, handler: transformDefinition },
            },
          ],
        },
      },
    }),
    transform: { filter: transformFilter, handler: transformDefinition },
  };
}
