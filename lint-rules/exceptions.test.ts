// Every rule that takes an `exceptions` option reads its default map from
// rules/<rule-name>.exceptions.json. Each listed path must still report when
// linted with that rule and no exceptions, so a stale exception fails here.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import plugin from './factory.mjs';
import { EXCEPTIONS_SCHEMA } from './lib/exceptions.mjs';
import {
  oxlintBinary,
  oxlintReportSchema,
  pluginSpecifier,
  repositoryRoot,
} from './testing/rule-fixtures';

const directory = mkdtempSync(join(tmpdir(), 'ff-oxlint-exceptions-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const rulesDirectory = join(repositoryRoot, 'lint-rules/rules');
const suffix = '.exceptions.json';
const exceptionsSchema = z.record(z.string(), z.string().min(1));

const rulesTakingExceptions = Object.entries(
  z
    .record(z.string(), z.object({ meta: z.object({ schema: z.unknown() }).partial() }))
    .parse(plugin.rules)
)
  .filter(([, rule]) => rule.meta.schema === EXCEPTIONS_SCHEMA)
  .map(([name]) => name);
const rulesWithExceptionFiles = readdirSync(rulesDirectory)
  .filter((file) => file.endsWith(suffix))
  .map((file) => file.slice(0, -suffix.length));

describe.each([...new Set([...rulesTakingExceptions, ...rulesWithExceptionFiles])].toSorted())(
  'factory/%s exceptions',
  (rule) => {
    const file = join(rulesDirectory, `${rule}${suffix}`);
    const exceptions = existsSync(file)
      ? Object.entries(exceptionsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))))
      : [];

    it('gives every file a reason', () => {
      // An exceptions file belongs to a rule that takes the option.
      expect(rulesTakingExceptions).toContain(rule);
      for (const [, reason] of exceptions) {
        expect(reason.length).toBeGreaterThan(20);
      }
    });

    it.runIf(exceptions.length > 0)('still needs every exception', () => {
      // Lint the listed files with the rule and no exceptions: each must still report.
      const ruleConfig = join(directory, `${rule}.oxlintrc.json`);
      writeFileSync(
        ruleConfig,
        JSON.stringify({
          categories: { correctness: 'off' },
          plugins: [],
          jsPlugins: [{ name: 'factory', specifier: pluginSpecifier }],
          rules: { [`factory/${rule}`]: ['error', { exceptions: {} }] },
        })
      );
      const files = exceptions.map(([path]) => path);
      const result = spawnSync(
        oxlintBinary,
        ['--config', ruleConfig, '--format', 'json', ...files],
        { cwd: repositoryRoot, encoding: 'utf8' }
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe('');
      const reported = new Set(
        oxlintReportSchema
          .parse(JSON.parse(result.stdout))
          .diagnostics.filter(({ code }) => code === `factory(${rule})`)
          .map(({ filename }) => filename)
      );
      expect(files.filter((path) => !reported.has(path))).toEqual([]);
    });
  }
);
