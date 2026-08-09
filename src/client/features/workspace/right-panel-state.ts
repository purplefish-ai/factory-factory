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

  try {
    const key = `${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`;
    const storedTop = storage.getItem(key);
    const topTab = parseStoredTopTab(storedTop);
    if (!topTab) {
      return defaultState;
    }
    if (storedTop !== topTab) {
      storage.setItem(key, topTab);
    }
    return { topTab };
  } catch {
    return defaultState;
  }
}
