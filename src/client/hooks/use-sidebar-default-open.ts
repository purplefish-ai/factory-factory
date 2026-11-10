import { useState } from 'react';
import { readStorageItem } from '@/client/lib/browser-storage';

const STORAGE_KEY = 'sidebar_state';

function getPersistedState(): boolean {
  // Migrate an existing explicit preference; the old board state was transient.
  for (const key of [STORAGE_KEY, 'sidebar_state_workspace_detail', 'sidebar_state_default']) {
    const value = readStorageItem(key);
    if (value === 'true' || value === 'false') {
      return value === 'true';
    }
  }
  return true;
}

/** One desktop sidebar preference, preserved across project and workspace navigation. */
export function useRouteSidebarState(): [boolean, (open: boolean) => void] {
  // SidebarProvider owns persistence; this hook supplies its controlled state.
  return useState(getPersistedState);
}
