import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';

type Mode = 'production' | 'exports';
const inventoryModeSchema = z.enum(['--report', '--update']).optional();
type InventoryMode = z.infer<typeof inventoryModeSchema>;

const repositoryPath = z
  .string()
  .min(1)
  .refine((path) => {
    if (path.includes('\\') || path.includes(':') || path.startsWith('/')) {
      return false;
    }
    return path
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  }, 'Expected a repository-relative path');
const exportKey = z.string().refine((key) => {
  const [file, kind, name, extra] = key.split('::');
  return (
    repositoryPath.safeParse(file).success &&
    (kind === 'exports' || kind === 'types') &&
    Boolean(name) &&
    extra === undefined
  );
}, 'Expected file::exports|types::symbol');
const reviewSchema = z
  .object({
    disposition: z.enum(['maintained-api', 'test-support', 'build-input', 'review-required']),
    reason: z.string().trim().min(12),
  })
  .strict();
const baselineSchema = z
  .object({
    version: z.literal(1),
    production: z.record(repositoryPath, reviewSchema),
    exports: z.record(exportKey, reviewSchema),
  })
  .strict();

type Inventory = z.infer<typeof baselineSchema>['production'];
type Review = z.infer<typeof reviewSchema>;

export function parseUnusedCodeBaseline(value: unknown) {
  return baselineSchema.parse(value);
}

type UnusedCodeConvention = {
  name: string;
  sections: readonly Mode[];
  /** Matched against the repository-relative path of the candidate's file. */
  pattern: RegExp;
  /** Cover only symbols the file re-exports, never ones it declares itself. */
  reExportsOnly?: true;
  review: Review;
};

/**
 * Location conventions. A candidate whose file matches one needs no baseline
 * entry and takes the convention's disposition; the first match wins. An
 * explicit baseline entry with a different disposition overrides it. Keep this
 * list short: add a convention only when its location alone explains every
 * file it matches. See docs/knip.md.
 */
export const unusedCodeConventions: readonly UnusedCodeConvention[] = [
  {
    name: 'test-support directory',
    sections: ['production', 'exports'],
    pattern: /(?:^|\/)(?:testing|test-utils|fixtures)\//u,
    review: {
      disposition: 'test-support',
      reason:
        'Lives in a testing, test-utils or fixtures directory; test and story support stays outside the production graph.',
    },
  },
  {
    name: 'test-support file name',
    sections: ['production', 'exports'],
    pattern: /\.(?:test-helpers|test-support|test-harness|story-fixtures|fixture)\.[cm]?[jt]sx?$/u,
    review: {
      disposition: 'test-support',
      reason:
        'Named *.test-helpers, *.test-support, *.test-harness, *.story-fixtures or *.fixture; test and story support stays outside the production graph.',
    },
  },
  {
    name: 'module barrel re-export',
    sections: ['exports'],
    pattern: /^src\/(?:.+\/)?index\.tsx?$/u,
    reExportsOnly: true,
    review: {
      disposition: 'maintained-api',
      reason:
        'Retain the architecture barrel contract; review external export visibility separately from implementation reachability.',
    },
  },
  {
    name: 'shadcn component',
    sections: ['exports'],
    pattern: /^src\/components\/ui\/[^/]+\.tsx?$/u,
    review: {
      disposition: 'maintained-api',
      reason:
        'Retain the maintained shadcn component surface; export visibility alone does not justify trimming its API.',
    },
  },
];

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    );
  }
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement);
  return named && statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : [];
}

function exportModifierNames(statement: ts.Statement): string[] {
  if (ts.isExportAssignment(statement)) {
    return ['default'];
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    return [];
  }
  return hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ? ['default']
    : declaredNames(statement);
}

/** `export { local as exported }` clauses without a `from` module. */
function localExportClauses(statement: ts.Statement) {
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return [];
  }
  return statement.exportClause.elements.map((element) => ({
    local: (element.propertyName ?? element.name).text,
    exported: element.name.text,
  }));
}

/** Export names a module declares itself, as opposed to re-exporting them. */
export function locallyDeclaredExports(file: string, source: string): Set<string> {
  const { statements } = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  const declared = new Set(statements.flatMap(declaredNames));
  return new Set([
    ...statements.flatMap(exportModifierNames),
    ...statements
      .flatMap(localExportClauses)
      .filter((clause) => declared.has(clause.local))
      .map((clause) => clause.exported),
  ]);
}

/** Candidates the conventions explain, keyed by inventory key. */
export function deriveConventions(
  section: Mode,
  keys: readonly string[],
  readSource: (file: string) => string
): Map<string, UnusedCodeConvention> {
  const localExports = new Map<string, Set<string>>();
  const declaredIn = (file: string) => {
    const cached = localExports.get(file);
    if (cached) {
      return cached;
    }
    const names = locallyDeclaredExports(file, readSource(file));
    localExports.set(file, names);
    return names;
  };
  const derived = new Map<string, UnusedCodeConvention>();
  for (const key of keys) {
    const [file = key, , name = ''] = key.split('::');
    const convention = unusedCodeConventions.find(
      (candidate) =>
        candidate.sections.includes(section) &&
        candidate.pattern.test(file) &&
        !(candidate.reExportsOnly && declaredIn(file).has(name))
    );
    if (convention) {
      derived.set(key, convention);
    }
  }
  return derived;
}

/** Explicit entries a convention already explains with the same disposition. */
export function redundantEntries(
  baseline: Inventory,
  derived: ReadonlyMap<string, UnusedCodeConvention>
) {
  return Object.keys(baseline)
    .filter((key) => derived.get(key)?.review.disposition === baseline[key]?.disposition)
    .sort();
}

const symbolSchema = z
  .object({
    name: z.string().min(1),
    namespace: z.string().optional(),
    line: z.number().int().optional(),
    col: z.number().int().optional(),
    pos: z.number().int().optional(),
  })
  .strict();
const productionReportSchema = z
  .object({
    issues: z.array(
      z
        .object({
          file: repositoryPath,
          files: z.array(symbolSchema).min(1),
        })
        .strict()
    ),
  })
  .strict();
const exportReportSchema = z
  .object({
    issues: z.array(
      z
        .object({
          file: repositoryPath,
          exports: z.array(symbolSchema),
          types: z.array(symbolSchema),
        })
        .strict()
    ),
  })
  .strict();

type AnalyzerResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: string | null;
  error?: Error;
};

export function parseKnipOutput(result: AnalyzerResult, mode: Mode): string[] {
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `Knip ${mode} failed: ${result.error?.message ?? result.signal ?? result.stderr}`
    );
  }
  const raw: unknown = JSON.parse(result.stdout);
  const keys: string[] =
    mode === 'production'
      ? productionReportSchema.parse(raw).issues.map((issue) => issue.file)
      : exportReportSchema
          .parse(raw)
          .issues.flatMap((issue) => [
            ...issue.exports.map((symbol) => `${issue.file}::exports::${symbol.name}`),
            ...issue.types.map((symbol) => `${issue.file}::types::${symbol.name}`),
          ]);
  if (result.status === 1 && keys.length === 0) {
    throw new Error(`Knip ${mode} failed without findings: ${result.stderr}`);
  }
  return [...new Set(keys)].sort();
}

const noConventions: ReadonlyMap<string, UnusedCodeConvention> = new Map();

export function compareInventory(
  current: readonly string[],
  baseline: Inventory,
  derived = noConventions
) {
  const keys = new Set(current);
  return {
    added: current.filter((key) => !(Object.hasOwn(baseline, key) || derived.has(key))).toSorted(),
    stale: Object.keys(baseline)
      .filter((key) => !keys.has(key))
      .sort(),
  };
}

export function pruneInventory(
  current: readonly string[],
  baseline: Inventory,
  derived = noConventions
): Inventory {
  if (compareInventory(current, baseline, derived).added.length > 0) {
    throw new Error(
      'Cannot update inventory with unreviewed candidates; review each new key first.'
    );
  }
  const redundant = new Set(redundantEntries(baseline, derived));
  return Object.fromEntries(
    current
      .filter((key) => !redundant.has(key))
      .map((key) => [key, baseline[key]])
      .filter((entry): entry is [string, Review] => entry[1] !== undefined)
  );
}

function analyze(mode: Mode) {
  return parseKnipOutput(
    spawnSync(
      process.execPath,
      [
        resolve('node_modules/knip/bin/knip.js'),
        '--config',
        'knip.json',
        '--no-progress',
        '--no-config-hints',
        '--include',
        mode === 'production' ? 'files' : 'exports,types',
        '--reporter',
        'json',
        ...(mode === 'production' ? ['--production'] : []),
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }
    ),
    mode
  );
}

function run() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--report', '--update'].includes(args[0] ?? ''))) {
    throw new Error('Usage: check-unused-code.ts [--report|--update]');
  }
  const path = resolve('scripts/unused-code-baseline.json');
  const baseline = parseUnusedCodeBaseline(JSON.parse(readFileSync(path, 'utf8')));
  const production = analyze('production');
  const exports = analyze('exports');
  const result = evaluateInventory(
    inventoryModeSchema.parse(args[0]),
    baseline,
    production,
    exports
  );
  if (result.baseline !== undefined) {
    writeFileSync(path, result.baseline);
  }
  process.stdout.write(result.output);
}

export function evaluateInventory(
  mode: InventoryMode,
  baseline: z.infer<typeof baselineSchema>,
  production: string[],
  exports: string[],
  readSource: (file: string) => string = (file) => readFileSync(resolve(file), 'utf8')
): { output: string; baseline?: string } {
  inventoryModeSchema.parse(mode);
  const candidates = { production, exports };
  const derived = {
    production: deriveConventions('production', production, readSource),
    exports: deriveConventions('exports', exports, readSource),
  };
  const driftFor = (section: Mode) => ({
    ...compareInventory(candidates[section], baseline[section], derived[section]),
    redundant: redundantEntries(baseline[section], derived[section]),
  });
  const drift = { production: driftFor('production'), exports: driftFor('exports') };
  const reviewOf = (section: Mode, key: string) => {
    const explicit = baseline[section][key];
    const convention = explicit ? undefined : derived[section].get(key);
    return { review: explicit ?? convention?.review ?? null, convention: convention?.name ?? null };
  };
  if (mode === '--report') {
    return {
      output: `${JSON.stringify(
        {
          version: 1,
          production: production.map((file) => ({ file, ...reviewOf('production', file) })),
          exports: exports.map((key) => ({ key, ...reviewOf('exports', key) })),
          drift,
        },
        null,
        2
      )}\n`,
    };
  }
  if (mode === '--update') {
    const next = {
      version: 1,
      production: pruneInventory(production, baseline.production, derived.production),
      exports: pruneInventory(exports, baseline.exports, derived.exports),
    };
    return {
      baseline: `${JSON.stringify(next, null, 2)}\n`,
      output: 'Pruned resolved and convention-covered unused-code inventory entries.\n',
    };
  }
  const violations = (['production', 'exports'] as const).flatMap((section) => [
    ...drift[section].added.map((key) => `New ${section} candidate: ${key}`),
    ...drift[section].stale.map((key) => `Stale ${section} candidate: ${key}`),
    ...drift[section].redundant.map(
      (key) =>
        `Redundant ${section} entry: ${key} (covered by the '${derived[section].get(key)?.name}' convention)`
    ),
  ]);
  if (violations.length > 0) {
    throw new Error(
      `${violations.join('\n')}\nReview new candidates; run pnpm check:unused-code:update to prune resolved and convention-covered entries. See docs/knip.md.`
    );
  }
  const byConvention = (section: Mode) =>
    candidates[section].filter((key) => reviewOf(section, key).convention !== null).length;
  return {
    output: `Unused-code inventory matches: ${production.length} production files (${byConvention('production')} by convention), ${exports.length} export visibility candidates (${byConvention('exports')} by convention).\n`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run();
  } catch (error) {
    process.stderr.write(
      `Unused-code check failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
