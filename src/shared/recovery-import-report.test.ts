import { expect, it } from 'vitest';
import definitions from '@/shared/testing/recovery-automation-definitions-v8.fixture.json';
import full from '@/shared/testing/recovery-base-json-v8.fixture.json';
import fixed from '@/shared/testing/recovery-base-v8.fixture.json';
import periodic from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import history from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import links from '@/shared/testing/recovery-periodic-links-v8.fixture.json';
import slackWire from '@/shared/testing/recovery-slack-connections-v8.fixture.json';
import expectedSlack from '@/shared/testing/recovery-slack-import-report.fixture.json';
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

it('names the exact full-profile physical catalog and preserves other warnings', () => {
  const report = createRecoveryImportReport(recoveryMetadataSchema.parse(full.meta.recovery));
  expect(report.manifest).toEqual(full.meta.recovery);
  expect(report.warnings).toEqual([
    'Partial logical metadata only; physical nullable-JSON fidelity is supported for Workspace.creationMetadata, WorkspacePR.observation on actual included PR rows, and AgentSession.providerMetadata. Omitted domains are not restored.',
    createRecoveryImportReport(recoveryMetadataSchema.parse(fixed.meta.recovery)).warnings[1],
  ]);
});

it('reports typed periodic totals separately while preserving historical result shapes and warning bytes', () => {
  const totals = {
    model: 'PeriodicTask' as const,
    imported: 2,
    skipped: 3,
    sourceEnabled: 4,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
  };
  const result = createRecoveryImportReport(
    recoveryMetadataSchema.parse(periodic.meta.recovery),
    totals
  );
  expect(result.periodicConfig).toEqual(totals);
  expect(result.warnings.slice(0, 2)).toEqual(
    createRecoveryImportReport(recoveryMetadataSchema.parse(full.meta.recovery)).warnings
  );
  expect(result.warnings[2]).toBe(
    'Periodic configuration restored disabled: 2 imported, 3 skipped; 4 enabled in the entire source section; 2 restored disabled. Skips by reason: existing task ID: 1; project not created by this import: 2. Periodic execution history excluded.'
  );
  for (const original of [fixed, workspace, full]) {
    const old = createRecoveryImportReport(recoveryMetadataSchema.parse(original.meta.recovery));
    expect(Object.keys(old)).toEqual(['status', 'manifest', 'warnings', 'unreportedTotals']);
    expect(old).not.toHaveProperty('periodicConfig');
  }
});

it.each([
  { imported: 0, skipped: 0 },
  { imported: 0, skipped: 5 },
  { imported: 2, skipped: 3 },
])('retains exact typed source-link counters %j and historical warnings', (counts) => {
  const report = createRecoveryImportReport(
    recoveryMetadataSchema.parse(links.meta.recovery),
    undefined,
    { model: 'Workspace', ...counts, reasons: { INCOMPLETE_DEPENDENCY: counts.skipped } }
  );
  expect(report.periodicWorkspaceLinks).toEqual({
    model: 'Workspace',
    ...counts,
    reasons: { INCOMPLETE_DEPENDENCY: counts.skipped },
  });
  expect(report.warnings.slice(0, 2)).toEqual(
    createRecoveryImportReport(recoveryMetadataSchema.parse(full.meta.recovery)).warnings
  );
  expect(report.warnings[2]).toBe(
    `Periodic workspace links: ${counts.imported} imported, ${counts.skipped} skipped. Only links present in the backup are counted; these counts overlap workspace totals. Skips mean the workspace or task was not created by this import. Linked tasks are restored disabled; periodic execution history is excluded.`
  );
  for (const original of [fixed, workspace, full, periodic]) {
    expect(
      createRecoveryImportReport(recoveryMetadataSchema.parse(original.meta.recovery))
    ).not.toHaveProperty('periodicWorkspaceLinks');
  }
});

it('reports history source scope separately from actual transforms without old history exclusions', () => {
  const counts = {
    model: 'PeriodicTaskExecution' as const,
    imported: 3,
    skipped: 6,
    sourceRunning: 5,
    restoredHistoricalFailed: 2,
    restoredSettled: 1,
    reasons: { EXISTING_IDENTITY: 1, CONFLICTING_IDENTITY_OR_PARENT: 2, INCOMPLETE_DEPENDENCY: 3 },
  };
  const report = createRecoveryImportReport(
    recoveryMetadataSchema.parse(history.meta.recovery),
    {
      model: 'PeriodicTask',
      imported: 2,
      skipped: 3,
      sourceEnabled: 4,
      restoredDisabled: 2,
      reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
    },
    { model: 'Workspace', imported: 2, skipped: 3, reasons: { INCOMPLETE_DEPENDENCY: 3 } },
    counts
  );
  expect(report.periodicHistory).toEqual(counts);
  expect(report.warnings.join(' ')).not.toMatch(/periodic execution history (?:is )?excluded/i);
  expect(report.warnings[0]).toContain('PeriodicTaskExecution.launchSnapshot');
  expect(report.warnings.at(-1)).toBe(
    'Periodic execution history: 3 imported, 6 skipped; 5 RUNNING in the entire source section; 2 restored FAILED as historical only, provider outcome unknown; 1 restored settled. Skips by reason: existing execution ID: 1; occupied workspace: 2; dependency not created by this import: 3. Imported executions will not be resumed.'
  );
});

it('reports exact definition-body scope and retains every cumulative history/null warning', () => {
  const config = {
    model: 'PeriodicTask' as const,
    imported: 2,
    skipped: 3,
    sourceEnabled: 4,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
  };
  const linkCounts = {
    model: 'Workspace' as const,
    imported: 2,
    skipped: 3,
    reasons: { INCOMPLETE_DEPENDENCY: 3 },
  };
  const executions = {
    model: 'PeriodicTaskExecution' as const,
    imported: 3,
    skipped: 6,
    sourceRunning: 5,
    restoredHistoricalFailed: 2,
    restoredSettled: 1,
    reasons: { EXISTING_IDENTITY: 1, CONFLICTING_IDENTITY_OR_PARENT: 2, INCOMPLETE_DEPENDENCY: 3 },
  };
  const bodies = {
    model: 'AgentDefinition' as const,
    imported: 2,
    skipped: 3,
    sourceEnabled: 4,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
  };
  const report = createRecoveryImportReport(
    recoveryMetadataSchema.parse(definitions.meta.recovery),
    config,
    linkCounts,
    executions,
    bodies
  );
  const old = createRecoveryImportReport(
    recoveryMetadataSchema.parse(history.meta.recovery),
    config,
    linkCounts,
    executions
  );
  expect(report.automationDefinitions).toEqual(bodies);
  expect(
    report.warnings.filter((text) => !text.startsWith('Automation definition bodies'))
  ).toEqual(old.warnings);
  expect(report.warnings).toContain(
    'Automation definition bodies restored disabled: 2 imported, 3 skipped; 4 enabled in the entire source section; 2 restored disabled. Skips by reason: existing definition ID: 1; project not created by this import: 2. Connections, event configuration, proposal provenance, activation and automation execution history are excluded. Inspect recovered bodies and author new complete event configuration where editing is available.'
  );
  expect(report.manifest).toEqual(definitions.meta.recovery);
});

it('matches the independently authored complete Slack report, exact ordering, counts and JSON', () => {
  const counts = expectedSlack.recovery;
  const report = createRecoveryImportReport(
    recoveryMetadataSchema.parse(slackWire.meta.recovery),
    {
      model: 'PeriodicTask',
      imported: 2,
      skipped: 3,
      sourceEnabled: 4,
      restoredDisabled: 2,
      reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
    },
    { model: 'Workspace', imported: 2, skipped: 3, reasons: { INCOMPLETE_DEPENDENCY: 3 } },
    {
      model: 'PeriodicTaskExecution',
      imported: 3,
      skipped: 6,
      sourceRunning: 5,
      restoredHistoricalFailed: 2,
      restoredSettled: 1,
      reasons: {
        EXISTING_IDENTITY: 1,
        CONFLICTING_IDENTITY_OR_PARENT: 2,
        INCOMPLETE_DEPENDENCY: 3,
      },
    },
    {
      model: 'AgentDefinition',
      imported: 2,
      skipped: 3,
      sourceEnabled: 4,
      restoredDisabled: 2,
      reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 2 },
    },
    {
      model: 'AgentConnection',
      imported: 2,
      skipped: 3,
      sourceEnabled: 4,
      restoredDisabled: 2,
      reasons: { EXISTING_IDENTITY: 3 },
    }
  );
  expect(report).toEqual(counts);
  expect(JSON.parse(JSON.stringify(report))).toEqual(counts);
});
