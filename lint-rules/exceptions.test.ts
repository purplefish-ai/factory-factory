import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  oxlintBinary,
  oxlintReportSchema,
  pluginSpecifier,
  readProjectConfig,
  repositoryRoot,
} from './testing/rule-fixtures';

const directory = mkdtempSync(join(tmpdir(), 'ff-oxlint-exceptions-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const exceptionRuleSchema = z.tuple([
  z.literal('error'),
  z.object({ exceptions: z.record(z.string(), z.string().min(1)) }),
]);

describe.each([
  'use-pending-prop',
  'no-raw-spinner',
  'no-direct-web-storage',
  'no-arbitrary-font-size',
  'use-status-callout',
  'no-render-ref-write',
  'no-state-sync-effect',
  'button-icon-size',
  'button-size-variant',
  'icon-button-tooltip',
  'tooltip-provider-root',
  'focus-ring',
  'no-raw-tab-role',
  'stable-context-value',
])('factory/%s exceptions', (rule) => {
  const projectConfig = readProjectConfig();
  const exceptions = projectConfig.overrides.flatMap((override) => {
    const setting = override.rules[`factory/${rule}`];
    return Array.isArray(setting)
      ? Object.entries(exceptionRuleSchema.parse(setting)[1].exceptions)
      : [];
  });

  it('gives every file a reason', () => {
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
        rules: { [`factory/${rule}`]: 'error' },
      })
    );
    const files = exceptions.map(([file]) => file);
    const result = spawnSync(oxlintBinary, ['--config', ruleConfig, '--format', 'json', ...files], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    const reported = new Set(
      oxlintReportSchema
        .parse(JSON.parse(result.stdout))
        .diagnostics.filter(({ code }) => code === `factory(${rule})`)
        .map(({ filename }) => filename)
    );
    expect(files.filter((file) => !reported.has(file))).toEqual([]);
  });
});
