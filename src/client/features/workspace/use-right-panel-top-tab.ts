import { useCallback, useState } from 'react';
import {
  loadPersistedTopPanelState,
  STORAGE_KEY_TOP_TAB_PREFIX,
  type TopPanelTab,
} from './right-panel-state';

function loadTopTab(workspaceId: string): TopPanelTab {
  try {
    return loadPersistedTopPanelState(
      typeof window === 'undefined' ? null : window.localStorage,
      workspaceId
    ).topTab;
  } catch {
    return 'changes';
  }
}

export function useRightPanelTopTab(workspaceId: string) {
  const [state, setState] = useState(() => ({ workspaceId, tab: loadTopTab(workspaceId) }));
  if (state.workspaceId !== workspaceId) {
    setState({ workspaceId, tab: loadTopTab(workspaceId) });
  }

  const setActiveTopTab = useCallback(
    (tab: TopPanelTab) => {
      setState({ workspaceId, tab });
      try {
        localStorage.setItem(`${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`, tab);
      } catch {
        // Ignore storage errors.
      }
    },
    [workspaceId]
  );

  return {
    activeTopTab: state.workspaceId === workspaceId ? state.tab : 'changes',
    setActiveTopTab,
  };
}
