import type { RecoveryMetadata } from './schemas/recovery-envelope.schema';

export interface PeriodicConfigImportReport {
  model: 'PeriodicTask';
  imported: number;
  skipped: number;
  sourceEnabled: number;
  restoredDisabled: number;
  reasons: { EXISTING_IDENTITY: number; INCOMPLETE_DEPENDENCY: number };
}

export interface RecoveryImportReport {
  periodicConfig?: PeriodicConfigImportReport;
  status: 'PARTIAL';
  manifest: RecoveryMetadata | null;
  warnings: string[];
  unreportedTotals: 'EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS';
}
export function createRecoveryImportReport(
  metadata: RecoveryMetadata | undefined,
  periodicConfig?: PeriodicConfigImportReport
): RecoveryImportReport {
  return {
    ...(periodicConfig ? { periodicConfig } : {}),
    status: 'PARTIAL',
    manifest: metadata ?? null,
    warnings: [
      ...(!metadata ? ['This legacy backup has no versioned coverage declaration.'] : []),
      metadata?.profile === 'base-json-1' || metadata?.profile === 'base-json-periodic-config-1'
        ? 'Partial logical metadata only; physical nullable-JSON fidelity is supported for Workspace.creationMetadata, WorkspacePR.observation on actual included PR rows, and AgentSession.providerMetadata. Omitted domains are not restored.'
        : metadata?.profile === 'base-json-workspace-1'
          ? 'Partial logical metadata only; physical nullable-JSON fidelity is supported for Workspace.creationMetadata only. WorkspacePR.observation and AgentSession.providerMetadata physical nullable-JSON fidelity is unproven. Omitted domains are not restored.'
          : 'Partial logical metadata only; physical nullable-JSON fidelity is unproven. Omitted domains are not restored.',
      'Paths and provider-session IDs may be metadata; repository/worktree files, provider history bytes, secrets, native account homes and live runtime authority are excluded.',
      ...(periodicConfig
        ? [
            `Periodic configuration restored disabled: ${periodicConfig.imported} imported, ${periodicConfig.skipped} skipped; ${periodicConfig.sourceEnabled} enabled in the entire source section; ${periodicConfig.restoredDisabled} restored disabled. Skips by reason: existing task ID: ${periodicConfig.reasons.EXISTING_IDENTITY}; project not created by this import: ${periodicConfig.reasons.INCOMPLETE_DEPENDENCY}. Periodic execution history excluded.`,
          ]
        : []),
    ],
    unreportedTotals: 'EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS',
  };
}
