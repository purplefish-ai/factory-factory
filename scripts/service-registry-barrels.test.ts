import { describe, expect, test } from 'vitest';
import { getCapsuleBarrelWildcardErrors } from './service-registry-barrels';

const barrelPath = 'src/backend/services/alpha/index.ts';

describe('getCapsuleBarrelWildcardErrors', () => {
  test('accepts a barrel that lists every name', () => {
    expect(
      getCapsuleBarrelWildcardErrors([
        {
          path: barrelPath,
          source: `
import { AlphaService } from './service/alpha.service';
export { AlphaService, type AlphaOptions } from './service/alpha.service';
export type { AlphaEvent } from './service/alpha-event';
export { alphaSchema as schema } from '@/shared/alpha';
const alphaService = new AlphaService();
export { alphaService };
export const alphaLimit = 3;
`,
        },
      ])
    ).toEqual([]);
  });

  test('rejects a wildcard re-export of the inner service directory', () => {
    expect(
      getCapsuleBarrelWildcardErrors([
        {
          path: barrelPath,
          source: "export { named } from './named';\nexport * from './service';\n",
        },
      ])
    ).toEqual([
      "src/backend/services/alpha/index.ts has `export * from './service';`; list the names it exports explicitly so the capsule's public API reads in one file.",
    ]);
  });

  test('rejects namespace and type-only wildcards', () => {
    expect(
      getCapsuleBarrelWildcardErrors([
        {
          path: barrelPath,
          source: "export * as alpha from '@/shared/alpha';\nexport type * from './types';\n",
        },
      ])
    ).toEqual([
      "src/backend/services/alpha/index.ts has `export * as alpha from '@/shared/alpha';`; list the names it exports explicitly so the capsule's public API reads in one file.",
      "src/backend/services/alpha/index.ts has `export type * from './types';`; list the names it exports explicitly so the capsule's public API reads in one file.",
    ]);
  });
});
