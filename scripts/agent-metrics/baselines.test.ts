import { describe, expect, it } from 'vitest';
import { baselineSizes, lintExceptionEntries, sessionModuleCycleCount } from './baselines';

describe('baseline and exception-list metrics', () => {
  it('counts lint exception entries and baseline sizes', () => {
    const lintConfig = {
      rules: { a: ['error', { exceptions: { 'x.ts': 'reason', 'y.ts': 'reason' } }] },
      overrides: [
        {
          rules: {
            b: ['error', { exceptions: {} }],
            c: ['error', { exceptions: { 'z.ts': 'r' } }],
          },
        },
      ],
    };
    expect(lintExceptionEntries(lintConfig)).toBe(3);
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
        lintConfig
      )
    ).toEqual({ unusedCodeProduction: 1, unusedCodeExports: 2, fileLength: 1, lintExceptions: 3 });
    expect(() => lintExceptionEntries({ exceptions: ['x.ts'] })).toThrow();
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
