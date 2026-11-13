import { describe, expect, it } from 'vitest';
import { baselineSizes, isLintRuleExceptionsFile, sessionModuleCycleCount } from './baselines';

describe('baseline and exception-list metrics', () => {
  it('counts lint rule exception entries and baseline sizes', () => {
    expect(
      baselineSizes(
        {
          version: 1,
          production: {
            'src/a.ts': { disposition: 'maintained-api', reason: 'Kept for the CLI API.' },
          },
          exports: {
            'src/b.ts::exports::b': {
              disposition: 'test-support',
              reason: 'Used by test fixtures.',
            },
            'src/b.ts::types::B': { disposition: 'test-support', reason: 'Used by test fixtures.' },
          },
        },
        { 'src/c.ts': 1200 },
        [
          { path: 'lint-rules/rules/a.exceptions.json', content: '{"x.ts":"r","y.ts":"r"}' },
          { path: 'lint-rules/rules/b.exceptions.json', content: '{}' },
          { path: 'lint-rules/rules/c.exceptions.json', content: '{"z.ts":"r"}' },
        ]
      )
    ).toEqual({
      unusedCodeProduction: 1,
      unusedCodeExports: 2,
      fileLength: 1,
      lintRuleExceptions: 3,
    });
  });

  it('recognizes lint rule exceptions files by name', () => {
    expect(isLintRuleExceptionsFile('lint-rules/rules/no-raw-spinner.exceptions.json')).toBe(true);
    expect(isLintRuleExceptionsFile('lint-rules/rules/no-raw-spinner.mjs')).toBe(false);
    expect(isLintRuleExceptionsFile('lint-rules/rules/nested/x.exceptions.json')).toBe(false);
    expect(isLintRuleExceptionsFile('lint-rules/x.exceptions.json')).toBe(false);
  });

  it('reads the sessionModuleCycles length, or null while the file is absent', () => {
    expect(sessionModuleCycleCount(null)).toBeNull();
    expect(
      sessionModuleCycleCount(
        [
          'export const sessionModules = {};',
          'export const sessionModuleCycles: readonly (readonly [string, string])[] = [',
          "  ['chat', 'dispatch'],",
          "  ['data', 'events'],",
          '] as const;',
        ].join('\n')
      )
    ).toBe(2);
    expect(sessionModuleCycleCount('export const sessionModuleCycles = [];')).toBe(0);
    expect(() => sessionModuleCycleCount('export const sessionModules = {};')).toThrow(
      'no sessionModuleCycles array literal'
    );
  });
});
