import type { RatchetState } from '@prisma-gen/browser';

export type RatchetVisualState = 'off' | 'idle' | 'processing';
export type RatchetStateLike = RatchetState | string | null | undefined;

const STATE_LABELS: Record<RatchetState, string> = {
  IDLE: 'Idle',
  CI_RUNNING: 'CI Running',
  CI_FAILED: 'CI Failed',
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

export function getRatchetVisualState(enabled: boolean, animate: boolean): RatchetVisualState {
  if (!enabled) {
    return 'off';
  }
  return animate ? 'processing' : 'idle';
}
