import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { nullableRecoveryJsonFields } from '@/shared/schemas/recovery-json-storage.schema';

it('classifies every nullable Prisma JSON field so proof cannot silently become SQL absence', () => {
  const excluded: Readonly<Record<string, string>> = {
    'Project.issueTrackerConfig': 'Credential-bearing configuration excluded from restore.',
    'UserSettings.workspaceOrder': 'Reconstructible display cache.',
    'UserSettings.cachedSlashCommands': 'Reconstructible runtime cache.',
  };
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const expected: string[] = [];
  for (const model of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    for (const field of (model[2] ?? '').matchAll(/^\s*(\w+)\s+Json\?/gm)) {
      const key = `${model[1]}.${field[1]}`;
      if (!excluded[key]) {
        expected.push(key);
      }
    }
  }
  const covered = Object.entries(nullableRecoveryJsonFields).flatMap(([model, fields]) =>
    fields.map((field) => `${model}.${field}`)
  );
  expect(covered.sort()).toEqual(expected.sort());
});
