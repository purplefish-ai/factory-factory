// Oxlint's built-in no-restricted-imports keeps card header parts out of the
// admin settings routes; see README.md.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  oxlintBinary,
  oxlintReportSchema,
  readProjectConfig,
  repositoryRoot,
} from './testing/rule-fixtures';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ff-oxlint-restricted-imports-')));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('settings section card exceptions', () => {
  const projectConfig = readProjectConfig();
  const adminFiles = projectConfig.overrides
    .filter(
      (override) =>
        override.rules['no-restricted-imports'] === 'off' &&
        override.files.every((file) => file.startsWith('src/client/routes/admin/'))
    )
    .flatMap((override) => override.files);

  it('lets only the section shell and stat tiles build card headers', () => {
    expect(adminFiles).toEqual([
      'src/client/routes/admin/settings-section.tsx',
      'src/client/routes/admin/StatCard.tsx',
    ]);
  });

  it.each(adminFiles)('%s still needs its exception', (file) => {
    expect(readFileSync(join(repositoryRoot, file), 'utf8')).toMatch(
      /\b(?:CardHeader|CardTitle|CardDescription|CardAction)\b[^;]*from '@\/components\/ui\/card'/
    );
  });
});

describe('settings section card restriction', () => {
  const restriction = readProjectConfig().overrides.find((override) =>
    override.files.includes('src/client/routes/admin/**/*.tsx')
  )?.rules['no-restricted-imports'];
  const fixtures = {
    rejected: "import { CardHeader, CardTitle } from '@/components/ui/card';",
    accepted: "import { Card, CardContent } from '@/components/ui/card';",
  };

  it('rejects card header parts and allows the card body with the project options', () => {
    expect(restriction).toBeDefined();
    const ruleDirectory = mkdtempSync(join(directory, 'card-'));
    const ruleConfig = join(ruleDirectory, '.oxlintrc.json');
    writeFileSync(
      ruleConfig,
      JSON.stringify({
        categories: { correctness: 'off' },
        plugins: [],
        rules: { 'no-restricted-imports': restriction },
      })
    );
    const files = Object.entries(fixtures).map(([name, source]) => {
      const file = join(ruleDirectory, `${name}.tsx`);
      writeFileSync(file, source);
      return file;
    });
    const result = spawnSync(oxlintBinary, ['--config', ruleConfig, '--format', 'json', ...files], {
      cwd: ruleDirectory,
      encoding: 'utf8',
    });
    const diagnostics = oxlintReportSchema.parse(JSON.parse(result.stdout)).diagnostics;
    expect(diagnostics.map(({ filename, code }) => [filename, code])).toEqual([
      ['rejected.tsx', 'eslint(no-restricted-imports)'],
      ['rejected.tsx', 'eslint(no-restricted-imports)'],
    ]);
  });
});
