export type RatchetToggleCacheShape = {
  id: string;
  ratchetEnabled?: boolean;
  ratchetState?: string | null;
  ratchetButtonAnimated?: boolean;
};

export function applyRatchetToggleState<T extends Omit<RatchetToggleCacheShape, 'id'>>(
  item: T,
  enabled: boolean
): T {
  return {
    ...item,
    ratchetEnabled: enabled,
    ratchetState: enabled ? item.ratchetState : 'IDLE',
    ratchetButtonAnimated: enabled ? item.ratchetButtonAnimated : false,
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
