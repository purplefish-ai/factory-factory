import { type Plugin, parseAst } from 'vite';

/**
 * The weight policy from `src/lib/phosphor-icon-weights.ts`. `vite.config.ts` passes it
 * in so this module, which Vite's config loader bundles, has no extensionless imports.
 */
export interface PhosphorWeightPolicy {
  /** Every weight a definition module ships. */
  weights: readonly string[];
  /** Serializable allowlist; plugin names include it to invalidate Vite's dep cache. */
  allowlist: unknown;
  allowedWeights: (icon: string) => ReadonlySet<string>;
}

const definitionIdPattern =
  /[\\/]@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/]([A-Za-z0-9]+)\.es\.js$/;

interface Span {
  start: number;
  end: number;
}

function locateWeightEntries(code: string, weights: readonly string[]) {
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
  const entries = new Map<string, Span>();
  for (const element of list.elements) {
    const key = element?.type === 'ArrayExpression' ? element.elements[0] : undefined;
    if (
      element?.type !== 'ArrayExpression' ||
      element.elements.length !== 2 ||
      key?.type !== 'Literal' ||
      typeof key.value !== 'string' ||
      !weights.includes(key.value) ||
      entries.has(key.value)
    ) {
      throw new Error('expected each Map entry to be a unique `[weight, element]` pair');
    }
    entries.set(key.value, { start: element.start, end: element.end });
  }
  const missing = weights.filter((weight) => !entries.has(weight));
  if (missing.length > 0) {
    throw new Error(`missing weights: ${missing.join(', ')}`);
  }
  return { list: { start: list.start, end: list.end }, entries };
}

/** Drop the weights `icon` never renders from a Phosphor `dist/defs/<Name>.es.js` module. */
export function stripPhosphorWeights(
  code: string,
  icon: string,
  policy: PhosphorWeightPolicy
): string {
  let located: ReturnType<typeof locateWeightEntries>;
  try {
    located = locateWeightEntries(code, policy.weights);
  } catch (error) {
    throw new Error(
      `Unexpected Phosphor icon definition shape for ${icon}: ${
        error instanceof Error ? error.message : String(error)
      }. Update scripts/phosphor-icon-weights.ts for the installed @phosphor-icons/react.`,
      { cause: error }
    );
  }
  const allowed = policy.allowedWeights(icon);
  const kept = [...located.entries]
    .filter(([weight]) => allowed.has(weight))
    .map(([, span]) => code.slice(span.start, span.end));
  return `${code.slice(0, located.list.start)}[\n  ${kept.join(',\n  ')}\n]${code.slice(located.list.end)}`;
}

const transformFilter = { id: /@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/]/ };

/**
 * Strip unused icon weights in builds, the dev server, and dependency pre-bundling.
 */
export function phosphorIconWeights(policy: PhosphorWeightPolicy): Plugin {
  const name = `phosphor-icon-weights:${JSON.stringify(policy.allowlist)}`;
  const transformDefinition = (code: string, id: string) => {
    const icon = definitionIdPattern.exec(id.replace(/\?.*$/, ''))?.[1];
    // Rewriting the Map moves code, so explicitly drop mappings for this vendor data module.
    return icon ? { code: stripPhosphorWeights(code, icon, policy), map: { mappings: '' } } : null;
  };
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
