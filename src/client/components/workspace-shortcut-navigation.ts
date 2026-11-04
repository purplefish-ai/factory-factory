import type { ServerWorkspace } from './use-workspace-list-state';
import { groupWorkspacesForSidebar } from './workspace-sidebar-grouping';

type NavigableWorkspace = Pick<ServerWorkspace, 'id' | 'pendingRequestType'>;

/** Workspaces in sidebar order (Working, Waiting, Done), which ⌥↑/⌥↓ step through. */
export function getSidebarWorkspaceOrder(workspaces: ServerWorkspace[]): ServerWorkspace[] {
  const { waiting, working, done } = groupWorkspacesForSidebar(workspaces);
  return [...working, ...waiting, ...done];
}

/**
 * The workspace `step` places away from the current one, wrapping at the ends.
 * Outside a workspace, "next" starts at the top and "previous" at the bottom.
 */
export function getAdjacentWorkspaceId(
  orderedIds: readonly string[],
  currentId: string | undefined,
  step: 1 | -1
): string | null {
  if (orderedIds.length === 0) {
    return null;
  }
  const index = currentId ? orderedIds.indexOf(currentId) : -1;
  if (index < 0) {
    return (step === 1 ? orderedIds[0] : orderedIds.at(-1)) ?? null;
  }
  const next = orderedIds[(index + step + orderedIds.length) % orderedIds.length];
  return next === currentId ? null : (next ?? null);
}

/** The next workspace after the current one, in sidebar order, that is waiting on the user. */
export function getNextWorkspaceNeedingInput(
  ordered: readonly NavigableWorkspace[],
  currentId: string | undefined,
  needsAttention: (workspaceId: string) => boolean
): string | null {
  const start = currentId ? ordered.findIndex((workspace) => workspace.id === currentId) : -1;
  for (let offset = 1; offset <= ordered.length; offset++) {
    const workspace = ordered[(start + offset) % ordered.length];
    if (
      workspace &&
      workspace.id !== currentId &&
      (workspace.pendingRequestType || needsAttention(workspace.id))
    ) {
      return workspace.id;
    }
  }
  return null;
}
