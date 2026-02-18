import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY_PREFIX = 'workspace-tool-call-expansion-';
const MAX_EXPANSION_ENTRIES = 500;

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

function pruneExpansionState(expansionState: ExpansionStateRecord): ExpansionStateRecord {
  const entries = Object.entries(expansionState);
  if (entries.length <= MAX_EXPANSION_ENTRIES) {
    return expansionState;
  }

  return Object.fromEntries(entries.slice(entries.length - MAX_EXPANSION_ENTRIES));
}

interface ToolExpansionStateApi {
  getExpansionState: (key: string, defaultOpen: boolean) => boolean;
  setExpansionState: (key: string, open: boolean) => void;
}

export function useWorkspaceToolExpansionState(workspaceId?: string): ToolExpansionStateApi {
  const [expansionState, setExpansionStateStore] = useState<ExpansionStateRecord>(() =>
    workspaceId ? loadToolExpansionState(workspaceId) : {}
  );
  const loadedForWorkspaceRef = useRef<string | null>(workspaceId ?? null);
  const skipNextPersistRef = useRef(workspaceId !== undefined);
  const expansionStateRef = useRef(expansionState);
  expansionStateRef.current = expansionState;

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

  const getExpansionState = useCallback((key: string, defaultOpen: boolean) => {
    const currentExpansionState = expansionStateRef.current;
    if (!Object.hasOwn(currentExpansionState, key)) {
      return defaultOpen;
    }
    return currentExpansionState[key] === true;
  }, []);

  const setExpansionState = useCallback((key: string, open: boolean) => {
    setExpansionStateStore((prev) => {
      if (prev[key] === open) {
        return prev;
      }
      const next: ExpansionStateRecord = { ...prev };
      // Keep recently touched keys at the end to support FIFO pruning.
      if (Object.hasOwn(next, key)) {
        delete next[key];
      }
      next[key] = open;
      return pruneExpansionState(next);
    });
  }, []);

  return { getExpansionState, setExpansionState };
}
