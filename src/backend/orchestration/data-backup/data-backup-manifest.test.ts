import { expect, it } from 'vitest';
import { prismaModelNames } from '@/backend/services/registry';
import fixed from '@/shared/testing/recovery-slack-connections-v8.fixture.json';
import { assertRecoveryModelCoverage, createBaseRecoveryManifest } from './data-backup-manifest';

it('preserves the frozen export manifest while classifying new excluded models', () => {
  const manifest = createBaseRecoveryManifest();
  expect(manifest).toEqual(fixed.meta.recovery);
  expect(manifest.coverage.filter((e) => e.status === 'PARTIAL')).toHaveLength(18);
  expect(manifest.coverage.filter((e) => e.status === 'EXCLUDED')).toHaveLength(19);
  expect(manifest.coverage.map((entry) => entry.model)).not.toContain('SessionQuestionResponse');
  expect(() => assertRecoveryModelCoverage(prismaModelNames)).not.toThrow();
  expect(createBaseRecoveryManifest()).not.toBe(manifest);
});
it('fails closed when the live registry gains or loses a model', () => {
  expect(() => assertRecoveryModelCoverage([...prismaModelNames, 'FutureModel'])).toThrow();
  expect(() => assertRecoveryModelCoverage(prismaModelNames.slice(1))).toThrow();
});
