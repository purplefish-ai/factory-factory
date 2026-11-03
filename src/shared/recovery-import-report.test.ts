import { expect, it } from 'vitest';
import fixed from '@/shared/testing/recovery-base-v8.fixture.json';
import { createRecoveryImportReport } from './recovery-import-report';
import { recoveryMetadataSchema } from './schemas/recovery-envelope.schema';
it('retains validated v8 coverage and explicitly unreported side totals', () => {
  const manifest = recoveryMetadataSchema.parse(fixed.meta.recovery);
  const report = createRecoveryImportReport(manifest);
  expect(report.manifest).toEqual(fixed.meta.recovery);
  expect(report.unreportedTotals).toBe('EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS');
  expect(report.status).toBe('PARTIAL');
  expect(report.warnings.join(' ')).toMatch(/physical nullable-JSON/i);
});
it('does not invent a legacy coverage declaration', () => {
  const report = createRecoveryImportReport(undefined);
  expect(report.manifest).toBeNull();
  expect(report.warnings.join(' ')).toMatch(/no versioned coverage declaration/i);
});
