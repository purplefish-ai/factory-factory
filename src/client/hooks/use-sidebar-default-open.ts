import { useCallback, useState } from 'react';

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
  const [open, setOpenState] = useState(getPersistedState);
  const setOpen = useCallback((value: boolean) => {
    setOpenState(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Storage is optional.
    }
  }, []);
  return [open, setOpen];
}
