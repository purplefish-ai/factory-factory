import { useCallback, useRef } from 'react';
import { z } from 'zod';
import { usePersistedState } from '@/client/hooks/use-persisted-state';

const STORAGE_KEY_PREFIX = 'workspace-tool-call-expansion-';
const MAX_EXPANSION_ENTRIES = 500;

type ExpansionStateRecord = Record<string, boolean>;

const ExpansionStateSchema = z.record(z.string(), z.boolean());
const NO_EXPANSION_STATE: ExpansionStateRecord = {};

export function createToolSequenceExpansionKey(sequenceId: string): string {
  return `sequence:${sequenceId}`;
}

export function createToolCallExpansionKey(sequenceId: string, callId: string): string {
  return `call:${sequenceId}:${callId}`;
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

/** Without a workspace, expansion state is kept in memory only. */
export function useWorkspaceToolExpansionState(workspaceId?: string): ToolExpansionStateApi {
  const [expansionState, setExpansionStateStore] = usePersistedState(
    workspaceId ? `${STORAGE_KEY_PREFIX}${workspaceId}` : null,
    ExpansionStateSchema,
    NO_EXPANSION_STATE
  );
  const expansionStateRef = useRef(expansionState);
  expansionStateRef.current = expansionState;

  const getExpansionState = useCallback((key: string, defaultOpen: boolean) => {
    const currentExpansionState = expansionStateRef.current;
    if (!Object.hasOwn(currentExpansionState, key)) {
      return defaultOpen;
    }
    return currentExpansionState[key] === true;
  }, []);

  const setExpansionState = useCallback(
    (key: string, open: boolean) => {
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
    },
    [setExpansionStateStore]
  );

  return { getExpansionState, setExpansionState };
}
