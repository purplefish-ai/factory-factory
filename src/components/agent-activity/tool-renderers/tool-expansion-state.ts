import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY_PREFIX = 'workspace-tool-call-expansion-';

type ExpansionStateRecord = Record<string, boolean>;

function isExpansionStateRecord(value: unknown): value is ExpansionStateRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === 'boolean');
}

export function createToolSequenceExpansionKey(sequenceId: string): string {
  return `sequence:${sequenceId}`;
}

export function createToolCallExpansionKey(sequenceId: string, callId: string): string {
  return `call:${sequenceId}:${callId}`;
}

export function loadToolExpansionState(workspaceId: string): ExpansionStateRecord {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${workspaceId}`);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return isExpansionStateRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveToolExpansionState(
  workspaceId: string,
  expansionState: ExpansionStateRecord
): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${workspaceId}`, JSON.stringify(expansionState));
  } catch {
    // Ignore storage errors.
  }
}

interface ToolExpansionStateApi {
  getExpansionState: (key: string, defaultOpen: boolean) => boolean;
  setExpansionState: (key: string, open: boolean) => void;
}

export function useWorkspaceToolExpansionState(workspaceId?: string): ToolExpansionStateApi {
  const [expansionState, setExpansionStateStore] = useState<ExpansionStateRecord>({});
  const loadedForWorkspaceRef = useRef<string | null>(null);
  const skipNextPersistRef = useRef(false);

  useEffect(() => {
    if (!workspaceId) {
      setExpansionStateStore({});
      loadedForWorkspaceRef.current = null;
      skipNextPersistRef.current = false;
      return;
    }

    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }

    loadedForWorkspaceRef.current = workspaceId;
    skipNextPersistRef.current = true;
    setExpansionStateStore(loadToolExpansionState(workspaceId));
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || loadedForWorkspaceRef.current !== workspaceId) {
      return;
    }

    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }

    saveToolExpansionState(workspaceId, expansionState);
  }, [workspaceId, expansionState]);

  const getExpansionState = useCallback(
    (key: string, defaultOpen: boolean) => {
      if (!Object.hasOwn(expansionState, key)) {
        return defaultOpen;
      }
      return expansionState[key] === true;
    },
    [expansionState]
  );

  const setExpansionState = useCallback((key: string, open: boolean) => {
    setExpansionStateStore((prev) => {
      if (prev[key] === open) {
        return prev;
      }
      return { ...prev, [key]: open };
    });
  }, []);

  return { getExpansionState, setExpansionState };
}
