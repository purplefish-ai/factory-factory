export const WORKSPACE_FLOW_PHASES = [
  'NO_PR',
  'CI_WAIT',
  'RATCHET_VERIFY',
  'RATCHET_FIXING',
  'READY',
  'MERGED',
] as const;

export type WorkspaceFlowPhase = (typeof WORKSPACE_FLOW_PHASES)[number];

export const WORKSPACE_CI_OBSERVATIONS = [
  'NOT_FETCHED',
  'NO_CHECKS',
  'CHECKS_PENDING',
  'CHECKS_FAILED',
  'CHECKS_PASSED',
  'CHECKS_UNKNOWN',
] as const;

export type WorkspaceCiObservation = (typeof WORKSPACE_CI_OBSERVATIONS)[number];
