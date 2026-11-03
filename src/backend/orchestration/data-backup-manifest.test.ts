import { expect, it } from 'vitest';
import { prismaModelNames } from '@/backend/services/registry';
import fixed from '@/shared/testing/recovery-periodic-links-v8.fixture.json';
import { assertRecoveryModelCoverage, createBaseRecoveryManifest } from './data-backup-manifest';

it('classifies every current model with the frozen limitations', () => {
  const manifest = createBaseRecoveryManifest();
  expect(manifest).toEqual(fixed.meta.recovery);
  expect(manifest.coverage.filter((e) => e.status === 'PARTIAL')).toHaveLength(15);
  expect(manifest.coverage.filter((e) => e.status === 'EXCLUDED')).toHaveLength(22);
  expect(new Set(manifest.coverage.map((e) => e.model))).toEqual(new Set(prismaModelNames));
  expect(createBaseRecoveryManifest()).not.toBe(manifest);
});
it('fails closed when the live registry gains or loses a model', () => {
  expect(() => assertRecoveryModelCoverage([...prismaModelNames, 'FutureModel'])).toThrow();
  expect(() => assertRecoveryModelCoverage(prismaModelNames.slice(1))).toThrow();
});
