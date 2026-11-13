import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import plugin from '../factory.mjs';

export const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
export const oxlintBinary = join(repositoryRoot, 'node_modules/.bin/oxlint');
export const pluginSpecifier = join(repositoryRoot, 'lint-rules/factory.mjs');
export const ruleNames = Object.keys(plugin.rules);

export const oxlintReportSchema = z.object({
  diagnostics: z.array(
    z.object({
      filename: z.string(),
      code: z.string(),
      severity: z.string(),
    })
  ),
  number_of_files: z.number().int().nonnegative(),
});

const projectConfigSchema = z.object({
  rules: z.record(z.string(), z.unknown()),
  overrides: z.array(
    z.object({ files: z.array(z.string()), rules: z.record(z.string(), z.unknown()) })
  ),
});

/** The repository's `.oxlintrc.json`. */
export function readProjectConfig() {
  return projectConfigSchema.parse(
    JSON.parse(readFileSync(join(repositoryRoot, '.oxlintrc.json'), 'utf8'))
  );
}

/** A fixture source, written to its own module, or a source at a given relative path. */
type Fixture = string | { file: string; source: string };

/**
 * Lints each fixture as its own module with the real Oxlint binary and every
 * factory rule enabled. A rejected fixture must report exactly one error, from
 * `rule`; an accepted fixture must report nothing from any rule.
 */
export function describeRuleFixtures(
  rule: string,
  fixtures: { options?: Record<string, unknown>; rejected: string[]; accepted: Fixture[] }
) {
  describe(`factory/${rule}`, () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), `ff-oxlint-${rule}-`)));
    afterAll(() => rmSync(directory, { recursive: true, force: true }));

    const rejected = fixtures.rejected.map((source, index) => ({
      source,
      file: join(directory, `rejected-${index}.tsx`),
    }));
    const accepted = fixtures.accepted.map((fixture, index) =>
      typeof fixture === 'string'
        ? { source: fixture, file: join(directory, `accepted-${index}.tsx`) }
        : { source: fixture.source, file: join(directory, fixture.file) }
    );

    let report: z.infer<typeof oxlintReportSchema>;
    beforeAll(() => {
      const config = join(directory, '.oxlintrc.json');
      writeFileSync(
        config,
        JSON.stringify({
          categories: { correctness: 'off' },
          plugins: [],
          jsPlugins: [{ name: 'factory', specifier: pluginSpecifier }],
          rules: {
            ...Object.fromEntries(ruleNames.map((name) => [`factory/${name}`, 'error'])),
            [`factory/${rule}`]: fixtures.options ? ['error', fixtures.options] : 'error',
          },
        })
      );
      // Separate modules preserve every fixture's scope while sharing one real CLI startup.
      const all = [...rejected, ...accepted];
      for (const { file, source } of all) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source);
      }
      const result = spawnSync(
        oxlintBinary,
        ['--config', config, '--format', 'json', ...all.map(({ file }) => file)],
        { cwd: directory, encoding: 'utf8' }
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.stderr).toBe('');
      expect(result.status).toBe(1);
      report = oxlintReportSchema.parse(JSON.parse(result.stdout));
      expect(report.number_of_files).toBe(all.length);
      const filenames = all.map(({ file }) => relative(directory, file));
      for (const diagnostic of report.diagnostics) {
        expect(filenames).toContain(diagnostic.filename);
      }
    });

    it.each(rejected)('rejects $source', ({ file }) => {
      expect(
        report.diagnostics.filter(({ filename }) => filename === relative(directory, file))
      ).toEqual([
        { filename: relative(directory, file), code: `factory(${rule})`, severity: 'error' },
      ]);
    });

    it.runIf(accepted.length > 0).each(accepted)('permits $source', ({ file }) => {
      expect(
        report.diagnostics.filter(({ filename }) => filename === relative(directory, file))
      ).toEqual([]);
    });
  });
}
