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

export function updateWorkspaceRatchetState<T extends RatchetToggleCacheShape>(
  items: T[],
  workspaceId: string,
  enabled: boolean
): T[] {
  return items.map((item) =>
    item.id === workspaceId ? applyRatchetToggleState(item, enabled) : item
  );
}
