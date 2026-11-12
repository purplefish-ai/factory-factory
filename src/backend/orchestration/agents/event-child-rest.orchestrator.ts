import {
  sessionDataService,
  sessionDomainService,
  sessionLifecycleService,
} from '@/backend/services/session';
import { workspaceRelationshipsService } from '@/backend/services/workspace';
import type { WorkspaceStatus } from '@/shared/core';
import {
  eventChildRest,
  type EventChildRest,
  type EventChildRestState,
} from '@/shared/event-child-rest';
import type { SessionRuntimeState } from '@/shared/session-runtime';

type ChildSessionFacts = { working: boolean; queued: boolean; waitingOnPerson: boolean };
type ChildWorkspaceFacts = { status: WorkspaceStatus; hasHadSessions: boolean } | null;

/**
 * At-rest rule for one child. `null` is a deleted child known only from its
 * retained origin. `hasHadSessions` is the durable "started at least once" fact:
 * it is written when a non-browse provider client is first created, after
 * workspace init has queued the child's initial prompt.
 */
export function childRestState(
  workspace: ChildWorkspaceFacts,
  sessions: readonly ChildSessionFacts[]
): EventChildRestState {
  if (!workspace || workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING') {
    return 'ARCHIVED';
  }
  if (workspace.status === 'FAILED') {
    return 'SETUP_FAILED';
  }
  if (workspace.status !== 'READY' || !workspace.hasHadSessions) {
    return 'NOT_STARTED';
  }
  // A pending approval blocks its own session's turn and queue on a person.
  const active = sessions.filter((session) => !session.waitingOnPerson);
  if (active.some((session) => session.working || session.queued)) {
    return 'WORKING';
  }
  return active.length < sessions.length ? 'WAITING_ON_PERSON' : 'IDLE';
}

/** A turn is running while startup, a prompt or an FF-tracked task is in flight. */
function turnRunning(runtime: SessionRuntimeState) {
  return (
    runtime.activity === 'WORKING' ||
    runtime.phase === 'starting' ||
    runtime.phase === 'running' ||
    runtime.phase === 'stopping'
  );
}

/** Reads the at-rest signal through the workspace and session capsule barrels. */
export async function observeChildRest(parentWorkspaceId: string): Promise<EventChildRest> {
  const facts = await workspaceRelationshipsService.findChildRestFacts(parentWorkspaceId);
  const live = new Map(facts.workspaces.map((workspace) => [workspace.id, workspace]));
  const pending = sessionDomainService.getAllPendingRequests();
  const ids = [...new Set([...facts.retainedChildIds, ...live.keys()])].sort();
  const children: { workspaceId: string; state: EventChildRestState }[] = [];
  for (const workspaceId of ids) {
    const workspace = live.get(workspaceId) ?? null;
    const sessions =
      workspace && workspace.status === 'READY'
        ? (await sessionDataService.findAgentSessionsByWorkspaceId(workspaceId)).map((session) => ({
            working: turnRunning(sessionLifecycleService.getRuntimeSnapshot(session.id)),
            queued: sessionDomainService.getQueueLength(session.id) > 0,
            waitingOnPerson: pending.has(session.id),
          }))
        : [];
    children.push({ workspaceId, state: childRestState(workspace, sessions) });
  }
  return eventChildRest(children);
}
