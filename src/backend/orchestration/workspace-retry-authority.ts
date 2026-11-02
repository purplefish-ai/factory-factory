import { isDeepStrictEqual } from 'node:util';
import { ApplicationError } from '@/backend/lib/application-error';
import { WorkspaceInitFenceError } from '@/backend/lib/workspace-init-fence-error';
import { workspaceRetryAuthorityService } from '@/backend/services/agent-definition';
import { eventSessionAuthority } from '@/backend/services/session';
import { workspaceDataService } from '@/backend/services/workspace';
import type { WorkspaceInitGuard, WorkspaceRetryAvailability } from '@/shared/workspace-init-retry';

type Workspace = {
  id: string;
  projectId: string;
  status: string;
  worktreePath: string | null;
  initErrorMessage: string | null;
  initRetryCount: number;
  creationSource: string;
};
const blocked = (
  reason: Extract<WorkspaceRetryAvailability, { status: 'BLOCKED' }>['reason'],
  explanation: string
): WorkspaceRetryAvailability => ({ status: 'BLOCKED', reason, explanation });
const unavailable = () =>
  blocked(
    'AUTHORITY_UNAVAILABLE',
    'Event setup retry authority is unavailable. Refresh and try again.'
  );
export async function captureWorkspaceRetryGuard(
  workspace: Workspace
): Promise<WorkspaceInitGuard | undefined> {
  try {
    return await capture(workspace);
  } catch {
    throw new WorkspaceInitFenceError();
  }
}
async function capture(workspace: Workspace): Promise<WorkspaceInitGuard | undefined> {
  const target = { projectId: workspace.projectId, workspaceId: workspace.id };
  const origin = await workspaceDataService.readEventOrigin(target);
  if (!origin) {
    if (workspace.creationSource === 'EVENT_AGENT') {
      throw new ApplicationError('CONFLICT', 'Event workspace origin is unavailable');
    }
    return undefined;
  }
  const context = await workspaceRetryAuthorityService.read({ ...target, runId: origin.runId });
  const local = eventSessionAuthority.createWorkspaceRetryGuard(context);
  let revoked = false;
  const revoke = () => {
    revoked = true;
    local.revoke();
  };
  const assertCurrent = () => {
    try {
      if (revoked) {
        throw new WorkspaceInitFenceError();
      }
      local.assertCurrent();
    } catch {
      revoke();
      throw new WorkspaceInitFenceError();
    }
  };
  const guard: WorkspaceInitGuard = {
    context,
    assertCurrent,
    revoke,
    check: async () => {
      try {
        assertCurrent();
        const freshWorkspace = await workspaceDataService.findByIdWithProject(workspace.id);
        assertCurrent();
        if (
          !freshWorkspace ||
          freshWorkspace.project.isArchived ||
          ['ARCHIVING', 'ARCHIVED'].includes(freshWorkspace.status)
        ) {
          throw new WorkspaceInitFenceError();
        }
        const currentOrigin = await workspaceDataService.readEventOrigin(target);
        assertCurrent();
        if (!isDeepStrictEqual(currentOrigin, origin) || currentOrigin?.workspaceState !== 'LIVE') {
          throw new Error('Event workspace origin changed');
        }
        const current = await workspaceRetryAuthorityService.read({
          ...target,
          runId: origin.runId,
        });
        assertCurrent();
        if (
          !isDeepStrictEqual(current.fence.attempt, context.fence.attempt) ||
          current.initialMessageId !== context.initialMessageId
        ) {
          throw new Error('Event initial attempt changed');
        }
        await local.check();
        assertCurrent();
      } catch {
        revoke();
        throw new WorkspaceInitFenceError();
      }
    },
  };
  await guard.check();
  return guard;
}
export async function readWorkspaceRetryAvailability(
  workspace: Workspace
): Promise<WorkspaceRetryAvailability> {
  if (
    !(
      workspace.status === 'FAILED' ||
      (workspace.status === 'READY' && (!workspace.worktreePath || workspace.initErrorMessage))
    )
  ) {
    return blocked('NOT_RETRYABLE', 'Workspace setup does not need retrying.');
  }
  if (workspace.initRetryCount >= 3) {
    return blocked('RETRY_LIMIT', 'Maximum setup retry attempts (3) exceeded.');
  }
  try {
    const origin = await workspaceDataService.readEventOrigin({
      projectId: workspace.projectId,
      workspaceId: workspace.id,
    });
    if (origin) {
      const context = await workspaceRetryAuthorityService.read({
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        runId: origin.runId,
      });
      const availability = await initialAvailability(context);
      if (availability) {
        return availability;
      }
    }
    await captureWorkspaceRetryGuard(workspace);
    return { status: 'AVAILABLE' };
  } catch {
    return unavailable();
  }
}

async function initialAvailability(
  context: WorkspaceInitGuard['context']
): Promise<WorkspaceRetryAvailability | undefined> {
  if (context.fence.state === 'PENDING') {
    return context.preparation && context.preparation.state !== 'SAFE'
      ? blocked(
          'PREPARATION_INCOMPLETE',
          'The initial task was not sent. Event setup or cleanup is still incomplete.'
        )
      : blocked(
          'INITIAL_PENDING',
          'The event initial task has not been sent yet. Setup retry is unavailable while it owns initialization.'
        );
  }
  if (context.fence.state !== 'FINISHED') {
    return blocked(
      'INITIAL_UNRESOLVED',
      'Event initial delivery is unresolved. Setup cannot be retried yet.'
    );
  }
  try {
    await eventSessionAuthority.createWorkspaceRetryGuard(context).check();
  } catch (error) {
    if (!(error instanceof ApplicationError)) {
      return unavailable();
    }
    return blocked(
      'INITIAL_ACTIVE',
      'Event initial work is still finishing. Try again after it finishes.'
    );
  }
  return undefined;
}
