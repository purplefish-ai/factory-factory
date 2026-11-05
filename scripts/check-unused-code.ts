import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

export function parseUnusedCodeBaseline(value: unknown) {
  return baselineSchema.parse(value);
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

export function compareInventory(current: readonly string[], baseline: Inventory) {
  const keys = new Set(current);
  return {
    added: current.filter((key) => !Object.hasOwn(baseline, key)).toSorted(),
    stale: Object.keys(baseline)
      .filter((key) => !keys.has(key))
      .sort(),
  };
}

export function pruneInventory(current: readonly string[], baseline: Inventory): Inventory {
  if (compareInventory(current, baseline).added.length > 0) {
    throw new Error(
      'Cannot update inventory with unreviewed candidates; review each new key first.'
    );
  }
  return Object.fromEntries(
    current
      .map((key) => [key, baseline[key]])
      .filter((entry): entry is [string, z.infer<typeof reviewSchema>] => entry[1] !== undefined)
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
  exports: string[]
): { output: string; baseline?: string } {
  inventoryModeSchema.parse(mode);
  const drift = {
    production: compareInventory(production, baseline.production),
    exports: compareInventory(exports, baseline.exports),
  };
  if (mode === '--report') {
    return {
      output: `${JSON.stringify(
        {
          version: 1,
          production: production.map((file) => ({
            file,
            review: baseline.production[file] ?? null,
          })),
          exports: exports.map((key) => ({ key, review: baseline.exports[key] ?? null })),
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
      production: pruneInventory(production, baseline.production),
      exports: pruneInventory(exports, baseline.exports),
    };
    return {
      baseline: `${JSON.stringify(next, null, 2)}\n`,
      output: 'Pruned resolved unused-code inventory entries.\n',
    };
  }
  const violations = (['production', 'exports'] as const).flatMap((mode) => [
    ...drift[mode].added.map((key) => `New ${mode} candidate: ${key}`),
    ...drift[mode].stale.map((key) => `Stale ${mode} candidate: ${key}`),
  ]);
  if (violations.length > 0) {
    throw new Error(
      `${violations.join('\n')}\nReview new candidates; run pnpm check:unused-code:update to prune resolved entries. See docs/knip.md.`
    );
  }
  return {
    output: `Unused-code inventory matches: ${production.length} production files, ${exports.length} export visibility candidates.\n`,
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
