import { describe, expect, it } from 'vitest';
import fixed from '@/shared/testing/recovery-base-v8.fixture.json';
import { malformedRecoveryCases } from '@/shared/testing/recovery-envelope.fixture';
import { exportDataSchema } from './export-data.schema';
describe('frozen base-1 envelope', () => {
  it('preserves the fixed v8 manifest through client, router and service parses', () => {
    let parsed = exportDataSchema.parse(fixed);
    for (let i = 0; i < 2; i++) {
      parsed = exportDataSchema.parse(parsed);
    }
    expect(parsed.meta).toEqual(fixed.meta);
    expect(parsed.data).toHaveProperty('recovery', {});
  });
  it('accepts reordered canonical sets', () => {
    const file = structuredClone(fixed);
    file.meta.recovery.coverage.reverse();
    file.meta.recovery.exclusions.reverse();
    expect(exportDataSchema.safeParse(file).success).toBe(true);
  });
  it.each(malformedRecoveryCases)('rejects %s', (_name, mutate) => {
    const file = structuredClone(fixed);
    mutate(file);
    expect(exportDataSchema.safeParse(file).success).toBe(false);
  });
});

it.each([4, 5, 6, 7])(
  'keeps legacy version %s metadata/data unknown-field stripping',
  (schemaVersion) => {
    const parsed = exportDataSchema.parse({
      meta: {
        exportedAt: '2025-01-01T00:00:00.000Z',
        version: 'legacy-permissiveness',
        schemaVersion,
        futureField: true,
      },
      data: {
        projects: [],
        workspaces: [],
        agentSessions: [],
        terminalSessions: [],
        userSettings: null,
        futureSection: {},
      },
    });
    expect(parsed.meta).not.toHaveProperty('futureField');
    expect(parsed.data).not.toHaveProperty('futureSection');
    expect(parsed.meta.schemaVersion).toBe(schemaVersion === 7 ? 7 : 6);
  }
);
