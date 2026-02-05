import type { RatchetState } from '@prisma-gen/browser';

export type RatchetVisualState = 'off' | 'idle' | 'processing';
export type RatchetStateLike = RatchetState | string | null | undefined;

const PROCESSING_STATES = new Set<RatchetState>([
  'CI_RUNNING',
  'CI_FAILED',
  'MERGE_CONFLICT',
  'REVIEW_PENDING',
]);

const STATE_LABELS: Record<RatchetState, string> = {
  IDLE: 'Idle',
  CI_RUNNING: 'CI Running',
  CI_FAILED: 'CI Failed',
  MERGE_CONFLICT: 'Merge Conflict',
  REVIEW_PENDING: 'Review Pending',
  READY: 'Ready',
  MERGED: 'Merged',
};

export function getRatchetStateLabel(state: RatchetStateLike): string {
  if (!state) {
    return 'Idle';
  }
  if (state in STATE_LABELS) {
    return STATE_LABELS[state as RatchetState];
  }
  return state;
}

export function isRatchetProcessing(state: RatchetStateLike): boolean {
  if (!state) {
    return false;
  }
  return PROCESSING_STATES.has(state as RatchetState);
}

export function getRatchetVisualState(
  enabled: boolean,
  state: RatchetStateLike
): RatchetVisualState {
  if (!enabled) {
    return 'off';
  }
  return isRatchetProcessing(state) ? 'processing' : 'idle';
}
