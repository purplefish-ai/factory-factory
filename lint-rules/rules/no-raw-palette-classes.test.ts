import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeRuleFixtures, readProjectConfig, repositoryRoot } from '../testing/rule-fixtures';

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

const exceptionRuleSchema = z.tuple([
  z.literal('error'),
  z.object({ exceptions: z.record(z.string(), z.string().min(1)) }),
]);

describe('raw palette class exceptions', () => {
  const projectConfig = readProjectConfig();
  const exceptions = projectConfig.overrides.flatMap((override) => {
    const rule = override.rules['factory/no-raw-palette-classes'];
    return Array.isArray(rule) ? Object.entries(exceptionRuleSchema.parse(rule)[1].exceptions) : [];
  });

  it('keeps the allowlist small, with a reason for every file', () => {
    expect(exceptions.length).toBeGreaterThan(0);
    expect(exceptions.length).toBeLessThanOrEqual(8);
    for (const [, reason] of exceptions) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it.each(exceptions.map(([file]) => file))('%s still needs its exception', (file) => {
    // Same pattern as factory/no-raw-palette-classes in no-raw-palette-classes.mjs.
    expect(readFileSync(join(repositoryRoot, file), 'utf8')).toMatch(
      /(?<=^|[\s'"`:!])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|inset-ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|inset-shadow|text-shadow|drop-shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:50|[1-9]00|950)(?![\w-])/
    );
  });
});
