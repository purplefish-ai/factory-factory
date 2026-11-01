import type { SessionRuntimeState } from '@/shared/session-runtime';

export function getLiveSessionControlId(
  sessionId: string | null | undefined,
  connected: boolean,
  runtime: Pick<SessionRuntimeState, 'phase' | 'processState'>
): string | undefined {
  if (
    !connected ||
    runtime.processState !== 'alive' ||
    !['running', 'idle'].includes(runtime.phase)
  ) {
    return undefined;
  }
  return sessionId ?? undefined;
}
