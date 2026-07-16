import {
  deriveWorkspaceSidebarStatus,
  type WorkspaceSidebarStatus,
  type WorkspaceSidebarStatusInput,
} from '@/shared/workspace-sidebar-status';

type RatchetSidebarCacheFields = {
  sidebarStatus?: WorkspaceSidebarStatus;
  isWorking?: WorkspaceSidebarStatusInput['isWorking'];
  prUrl?: WorkspaceSidebarStatusInput['prUrl'];
  prState?: WorkspaceSidebarStatusInput['prState'];
  prCiStatus?: WorkspaceSidebarStatusInput['prCiStatus'];
};

export type RatchetToggleCacheShape = {
  id: string;
  ratchetEnabled?: boolean;
  ratchetState?: WorkspaceSidebarStatusInput['ratchetState'];
  ratchetButtonAnimated?: boolean;
} & RatchetSidebarCacheFields;

function deriveUpdatedSidebarStatus<T extends Omit<RatchetToggleCacheShape, 'id'>>(
  item: T,
  nextRatchetState: WorkspaceSidebarStatusInput['ratchetState']
): WorkspaceSidebarStatus | null {
  if (!('sidebarStatus' in item) || typeof item.isWorking !== 'boolean') {
    return null;
  }

  return deriveWorkspaceSidebarStatus({
    isWorking: item.isWorking,
    prUrl: item.prUrl ?? null,
    prState: item.prState ?? null,
    prCiStatus: item.prCiStatus ?? null,
    ratchetState: nextRatchetState ?? null,
  });
}

export function applyRatchetToggleState<T extends Omit<RatchetToggleCacheShape, 'id'>>(
  item: T,
  enabled: boolean
): T {
  const nextRatchetState = enabled ? item.ratchetState : 'IDLE';
  const nextState = {
    ...item,
    ratchetEnabled: enabled,
    ratchetState: nextRatchetState,
    ratchetButtonAnimated: enabled ? item.ratchetButtonAnimated : false,
  };

  const sidebarStatus = deriveUpdatedSidebarStatus(item, nextRatchetState ?? null);
  if (!sidebarStatus) {
    return nextState;
  }

  return {
    ...nextState,
    sidebarStatus,
  };
}

// =============================================================================
// Pending toggle registry
// =============================================================================
//
// While a toggleRatcheting mutation is in flight, snapshot messages computed
// before the mutation committed can still arrive and would overwrite the
// optimistic cache updates (visible flip-flop). The registry records the
// in-flight value per workspace so the snapshot sync hook can keep entries
// consistent with the pending toggle until the mutation settles.

const pendingRatchetToggles = new Map<string, boolean>();

export function setPendingRatchetToggle(workspaceId: string, enabled: boolean): void {
  pendingRatchetToggles.set(workspaceId, enabled);
}

export function clearPendingRatchetToggle(workspaceId: string): void {
  pendingRatchetToggles.delete(workspaceId);
}

export function resetPendingRatchetTogglesForTests(): void {
  pendingRatchetToggles.clear();
}

/**
 * Applies an in-flight ratchet toggle to a snapshot entry. Returns the entry
 * unchanged when no toggle is pending for its workspace or when the entry
 * already reflects the pending value.
 */
export function overridePendingRatchetToggle<
  T extends Omit<RatchetToggleCacheShape, 'id'> & { workspaceId: string },
>(entry: T): T {
  const pending = pendingRatchetToggles.get(entry.workspaceId);
  if (pending === undefined || pending === entry.ratchetEnabled) {
    return entry;
  }
  return applyRatchetToggleState(entry, pending);
}

export function updateWorkspaceRatchetState<T extends RatchetToggleCacheShape>(
  items: T[],
  workspaceId: string,
  enabled: boolean
): T[] {
  return items.map((item) =>
    item.id === workspaceId ? applyRatchetToggleState(item, enabled) : item
  );
}
