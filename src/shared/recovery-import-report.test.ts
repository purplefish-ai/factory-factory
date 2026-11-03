import { expect, it } from 'vitest';
import fixed from '@/shared/testing/recovery-base-v8.fixture.json';
import { createRecoveryImportReport } from './recovery-import-report';
import { recoveryMetadataSchema } from './schemas/recovery-envelope.schema';
import workspace from './testing/recovery-base-json-workspace-v8.fixture.json';
it('retains validated v8 coverage and explicitly unreported side totals', () => {
  const manifest = recoveryMetadataSchema.parse(fixed.meta.recovery);
  const report = createRecoveryImportReport(manifest);
  expect(report.manifest).toEqual(fixed.meta.recovery);
  expect(report.unreportedTotals).toBe('EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS');
  expect(report.status).toBe('PARTIAL');
  expect(report.warnings.join(' ')).toMatch(/physical nullable-JSON/i);
  expect(report.warnings.join(' ')).not.toMatch(/no versioned coverage declaration/i);
});
it('does not invent a legacy coverage declaration', () => {
  const report = createRecoveryImportReport(undefined);
  expect(report.manifest).toBeNull();
  expect(report.warnings.join(' ')).toMatch(/no versioned coverage declaration/i);
});

it('narrows physical-fidelity warnings only for the workspace profile', () => {
  const report = createRecoveryImportReport(recoveryMetadataSchema.parse(workspace.meta.recovery));
  expect(report.warnings[0]).toBe(
    'Partial logical metadata only; physical nullable-JSON fidelity is supported for Workspace.creationMetadata only. WorkspacePR.observation and AgentSession.providerMetadata physical nullable-JSON fidelity is unproven. Omitted domains are not restored.'
  );
  expect(report.manifest).toEqual(workspace.meta.recovery);
  expect(
    createRecoveryImportReport(recoveryMetadataSchema.parse(fixed.meta.recovery)).warnings[0]
  ).toBe(
    'Partial logical metadata only; physical nullable-JSON fidelity is unproven. Omitted domains are not restored.'
  );
});
