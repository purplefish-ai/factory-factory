import { createLogger } from '@/backend/services/logger.service';
import {
  EventWorkspaceFenceError,
  type EventWorkspaceClaim,
  workspaceEventInitAccessor,
} from '@/backend/services/workspace/resources/workspace-event-init.accessor';
import { WORKSPACE_STATE_CHANGED, workspaceStateMachine } from './state-machine.service';
export {
  EventWorkspaceFenceError,
  type EventWorkspaceClaim,
} from '@/backend/services/workspace/resources/workspace-event-init.accessor';

const logger = createLogger('event-workspace-init');
async function publish(
  claim: EventWorkspaceClaim,
  result: Awaited<ReturnType<typeof workspaceEventInitAccessor.start>>,
  assertCurrent?: () => void
) {
  const { previous, workspace } = result;
  const current = await workspaceEventInitAccessor.read(claim, assertCurrent);
  if (current.status !== workspace.status) {
    throw new EventWorkspaceFenceError();
  }
  if (previous !== current.status) {
    const event = {
      workspaceId: current.id,
      fromStatus: previous,
      toStatus: current.status,
      workspace: current,
    };
    const reportFailure = () =>
      logger.warn('Event workspace notification subscriber failed', { workspaceId: current.id });
    for (const listener of workspaceStateMachine.rawListeners(WORKSPACE_STATE_CHANGED)) {
      try {
        // Observe failures without letting a stalled observer hold READY or later listeners.
        void Promise.resolve(listener.call(workspaceStateMachine, event)).catch(reportFailure);
      } catch {
        reportFailure();
      }
    }
  }
  return current;
}
export const eventWorkspaceInitService = {
  read: workspaceEventInitAccessor.read,
  start: async (...args: Parameters<typeof workspaceEventInitAccessor.start>) =>
    publish(args[0], await workspaceEventInitAccessor.start(...args), args[1]),
  register: workspaceEventInitAccessor.register,
  finish: async (...args: Parameters<typeof workspaceEventInitAccessor.finish>) =>
    publish(args[0], await workspaceEventInitAccessor.finish(...args), args[3]),
  invalidateMissingWorktree: async (
    ...args: Parameters<typeof workspaceEventInitAccessor.invalidateMissingWorktree>
  ) =>
    publish(args[0], await workspaceEventInitAccessor.invalidateMissingWorktree(...args), args[2]),
  appendOutput: workspaceEventInitAccessor.appendOutput,
  scriptPid: workspaceEventInitAccessor.scriptPid,
};
