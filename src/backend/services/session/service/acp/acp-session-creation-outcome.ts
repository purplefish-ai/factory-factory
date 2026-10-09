export type AcpSessionCreationOutcome =
  | { kind: 'new' }
  | { kind: 'resumed' }
  | {
      kind: 'resume_fallback';
      previousProviderSessionId: string;
      reason: 'load_failed' | 'load_unsupported';
    };
