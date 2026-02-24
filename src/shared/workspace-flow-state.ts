export type WorkspaceFlowPhase =
  | 'NO_PR'
  | 'CI_WAIT'
  | 'RATCHET_VERIFY'
  | 'RATCHET_FIXING'
  | 'READY'
  | 'MERGED';

export type WorkspaceCiObservation =
  | 'NOT_FETCHED'
  | 'NO_CHECKS'
  | 'CHECKS_PENDING'
  | 'CHECKS_FAILED'
  | 'CHECKS_PASSED'
  | 'CHECKS_UNKNOWN';
