import type { RatchetState } from '@/shared/core';

export type RatchetVisualState = 'off' | 'idle' | 'processing';
export type RatchetStateLike = RatchetState | string | null | undefined;

const STATE_LABELS: Record<RatchetState, string> = {
  IDLE: 'Watching',
  CI_RUNNING: 'CI in progress',
  CI_FAILED: 'Fixing CI',
  REVIEW_PENDING: 'Addressing reviews',
  READY: 'Ready to merge',
  MERGED: 'Merged',
};

export function getRatchetStateLabel(state: RatchetStateLike): string {
  if (!state) {
    return 'Watching';
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
