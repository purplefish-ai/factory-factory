import { z } from 'zod';
import { sessionStopTargetSchema, type SessionStopTarget } from '@/shared/acp-protocol/subagents';
import type { AcpProcessHandle } from './acp-process-handle';
import { AcpSubagentBrowseError } from './acp-runtime-errors';
import { withTimeout } from './acp-runtime-spawn';

const stopResponseSchema = z.object({ stopped: z.boolean() });

export async function stopAcpTarget(
  handle: AcpProcessHandle | undefined,
  target: SessionStopTarget
): Promise<void> {
  if (!(handle?.isRunning() && handle.nativeSessionTracker)) {
    throw new AcpSubagentBrowseError(
      'PRECONDITION_FAILED',
      'Stopping this item requires its live parent session.'
    );
  }
  const parsed = sessionStopTargetSchema.safeParse(target);
  if (!parsed.success) {
    throw new AcpSubagentBrowseError('INVALID_INPUT', 'Invalid stop target.');
  }
  // Resolve and dispatch synchronously: no await may reopen a stale-handle race here.
  const dispatch = handle.nativeSessionTracker.resolveStopTarget(parsed.data);
  const operation =
    dispatch.kind === 'subagent'
      ? handle.connection.cancel({ sessionId: dispatch.sessionId })
      : handle.connection
          .extMethod('_session/async_task/stop', {
            sessionId: dispatch.sessionId,
            asyncTaskId: dispatch.asyncTaskId,
          })
          .then((response) => {
            const result = stopResponseSchema.safeParse(response);
            if (!(result.success && result.data.stopped)) {
              throw new AcpSubagentBrowseError(
                'PRECONDITION_FAILED',
                'The provider could not stop this process. Refresh and try again.'
              );
            }
          });
  await withTimeout({
    promise: operation,
    timeoutMs: 10_000,
    description: 'targeted stop request',
  });
}
