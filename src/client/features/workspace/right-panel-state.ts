export const STORAGE_KEY_TOP_TAB_PREFIX = 'workspace-right-panel-tab-';

export type TopPanelTab =
  | 'changes'
  | 'files'
  | 'tasks'
  | 'screenshots'
  | 'auto-iteration'
  | 'periodic-task'
  | 'agents';

export interface PersistedTopPanelState {
  topTab: TopPanelTab;
}

export function parseStoredTopTab(value: string | null): TopPanelTab | null {
  if (
    value === 'changes' ||
    value === 'files' ||
    value === 'tasks' ||
    value === 'screenshots' ||
    value === 'auto-iteration' ||
    value === 'periodic-task' ||
    value === 'agents'
  ) {
    return value;
  }
  if (value === 'child-workspaces') {
    return 'agents';
  }
  if (value === 'unstaged' || value === 'diff-vs-main') {
    return 'changes';
  }
  return null;
}

export function loadPersistedTopPanelState(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined,
  workspaceId: string
): PersistedTopPanelState {
  const defaultState: PersistedTopPanelState = { topTab: 'changes' };
  if (!storage) {
    return defaultState;
  }

  const key = `${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`;
  let storedTop: string | null;
  try {
    storedTop = storage.getItem(key);
  } catch {
    return defaultState;
  }

  const topTab = parseStoredTopTab(storedTop);
  if (!topTab) {
    return defaultState;
  }
  if (storedTop !== topTab) {
    try {
      storage.setItem(key, topTab);
    } catch {
      // A parsed preference is still usable when a best-effort migration write fails.
    }
  }
  return { topTab };
}
