import type { RecoveryMetadata } from './schemas/recovery-envelope.schema';

export interface RecoveryImportReport {
  status: 'PARTIAL';
  manifest: RecoveryMetadata | null;
  warnings: string[];
  unreportedTotals: 'EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS';
}
export function createRecoveryImportReport(
  metadata: RecoveryMetadata | undefined
): RecoveryImportReport {
  return {
    status: 'PARTIAL',
    manifest: metadata ?? null,
    warnings: [
      ...(!metadata ? ['This legacy backup has no versioned coverage declaration.'] : []),
      'Partial logical metadata only; physical nullable-JSON fidelity is unproven. Omitted domains are not restored.',
      'Paths and provider-session IDs may be metadata; repository/worktree files, provider history bytes, secrets, native account homes and live runtime authority are excluded.',
    ],
    unreportedTotals: 'EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS',
  };
}
