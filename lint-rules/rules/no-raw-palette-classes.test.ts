import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeRuleFixtures, repositoryRoot } from '../testing/rule-fixtures';

describeRuleFixtures('no-raw-palette-classes', {
  rejected: [
    'const className = "flex bg-red-500";',
    'export const chip = <span className="dark:text-emerald-300" />;',
    'const className = `${base} hover:border-sky-500/40`;',
    'const progress = "[&>div]:bg-zinc-900";',
    'const glow = "text-shadow-red-500";',
    'const className = "dark:text-red-500";',
    'const className = "p-2 !bg-red-500";',
    'const glow = "inset-ring-amber-400/50";',
  ],
  accepted: [
    'const className = "bg-success/10 text-running border-destructive/30";',
    'const className = "bg-black/60 text-white";',
    'const pattern = /text-red-500/;',
    'const id = "my-text-red-500-id";',
    'const url = "/api/text-red-500";',
    'const selector = "a.text-red-500";',
  ],
});

// Whether each listed file still needs its exception is checked with the rule
// itself in ../exceptions.test.ts.
describe('raw palette class exceptions', () => {
  const exceptions = Object.entries(
    z
      .record(z.string(), z.string().min(1))
      .parse(
        JSON.parse(
          readFileSync(
            join(repositoryRoot, 'lint-rules/rules/no-raw-palette-classes.exceptions.json'),
            'utf8'
          )
        )
      )
  );

  it('keeps the allowlist small, with a reason for every file', () => {
    expect(exceptions.length).toBeGreaterThan(0);
    expect(exceptions.length).toBeLessThanOrEqual(8);
    for (const [, reason] of exceptions) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
