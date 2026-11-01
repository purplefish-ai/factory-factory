import { workspaceEventInitAccessor } from '@/backend/services/workspace/resources/workspace-event-init.accessor';
import { workspaceAccessor } from '@/backend/services/workspace/resources/workspace.accessor';
import { WORKSPACE_STATE_CHANGED, workspaceStateMachine } from './state-machine.service';
export {
  EventWorkspaceFenceError,
  type EventWorkspaceClaim,
} from '@/backend/services/workspace/resources/workspace-event-init.accessor';

async function publish(result: Awaited<ReturnType<typeof workspaceEventInitAccessor.start>>) {
  const { previous, workspace } = result;
  if (previous !== workspace.status) {
    const current = await workspaceAccessor.findRawById(workspace.id);
    if (
      current?.status === workspace.status &&
      current.updatedAt.getTime() === workspace.updatedAt.getTime()
    ) {
      workspaceStateMachine.emit(WORKSPACE_STATE_CHANGED, {
        workspaceId: workspace.id,
        fromStatus: previous,
        toStatus: workspace.status,
        workspace: current,
      });
    }
  }
  return workspace;
}
export const eventWorkspaceInitService = {
  read: workspaceEventInitAccessor.read,
  start: async (...args: Parameters<typeof workspaceEventInitAccessor.start>) =>
    publish(await workspaceEventInitAccessor.start(...args)),
  register: workspaceEventInitAccessor.register,
  finish: async (...args: Parameters<typeof workspaceEventInitAccessor.finish>) =>
    publish(await workspaceEventInitAccessor.finish(...args)),
  appendOutput: workspaceEventInitAccessor.appendOutput,
  scriptPid: workspaceEventInitAccessor.scriptPid,
};
