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
