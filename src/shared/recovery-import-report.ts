/** Counts cover retained durable rows and archived transcripts, separately from base metadata. */
export type RecoveryImportReport = {
  models: { model: string; imported: number; skipped: number }[];
  skipped: {
    model: string;
    identity: string;
    reason: 'EXISTING_IDENTITY' | 'CONFLICTING_IDENTITY_OR_PARENT';
  }[];
};
