import { useState } from 'react';

const STORAGE_KEY = 'sidebar_state';

function getPersistedState(): boolean {
  try {
    // Migrate an existing explicit preference; the old board state was transient.
    for (const key of [STORAGE_KEY, 'sidebar_state_workspace_detail', 'sidebar_state_default']) {
      const value = localStorage.getItem(key);
      if (value === 'true' || value === 'false') {
        return value === 'true';
      }
    }
  } catch {
    // Storage is optional; navigation should still preserve the in-memory state.
  }
  return true;
}

/** One desktop sidebar preference, preserved across project and workspace navigation. */
export function useRouteSidebarState(): [boolean, (open: boolean) => void] {
  // SidebarProvider owns persistence; this hook supplies its controlled state.
  return useState(getPersistedState);
}
