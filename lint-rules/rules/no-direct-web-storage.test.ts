import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeRuleFixtures, readProjectConfig, repositoryRoot } from '../testing/rule-fixtures';

describeRuleFixtures('no-direct-web-storage', {
  rejected: [
    'const value = localStorage.getItem("key");',
    'window.localStorage.setItem("key", "value");',
    'sessionStorage.removeItem("key");',
    'const storage = globalThis["sessionStorage"];',
    'const area = typeof window === "undefined" ? null : window.localStorage;',
    'read({ localStorage });',
    'const storage = globalThis[`sessionStorage`];',
    'const { localStorage: store } = window;',
    'const { localStorage } = window;',
  ],
  accepted: [
    'const value = readStorageItem("key");',
    'const fromRecord = record.localStorage;',
    'const areas = { localStorage: "local", sessionStorage: "session" } as const;',
    'const kind: "localStorage" | "sessionStorage" = "localStorage";',
    'const value = storage.getItem("key"); type Reader = Pick<Storage, "getItem">;',
  ],
});

describe('web storage access', () => {
  it('is limited to the shared storage module and exempts only tests', () => {
    const overrides = readProjectConfig().overrides;
    const scopes = overrides
      .filter((override) => override.rules['factory/no-direct-web-storage'] !== undefined)
      .map((override) => [override.files, override.rules['factory/no-direct-web-storage']]);
    expect(scopes).toEqual([
      [
        ['src/client/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
        'error',
      ],
      [['**/*.test.ts', '**/*.test.tsx'], 'off'],
    ]);
    expect(
      JSON.parse(
        readFileSync(
          join(repositoryRoot, 'lint-rules/rules/no-direct-web-storage.exceptions.json'),
          'utf8'
        )
      )
    ).toEqual({ 'src/client/lib/browser-storage.ts': expect.any(String) });
  });
});
