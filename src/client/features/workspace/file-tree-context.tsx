import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { z } from 'zod';
import { usePersistedState } from '@/client/hooks/use-persisted-state';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_PREFIX = 'file-tree-expanded-';

const ExpandedPathsSchema = z.array(z.string()).transform((paths) => new Set(paths));
const NO_EXPANDED_PATHS = new Set<string>();

// =============================================================================
// Store
// =============================================================================

/** Holds the expanded set outside the context value so each folder subscribes
 * to its own boolean instead of the whole set. */
interface ExpandedPathsStore {
  get: () => ReadonlySet<string>;
  set: (paths: ReadonlySet<string>) => void;
  subscribe: (listener: () => void) => () => void;
}

function createExpandedPathsStore(initial: ReadonlySet<string>): ExpandedPathsStore {
  let paths = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => paths,
    set: (next) => {
      if (next === paths) {
        return;
      }
      paths = next;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// =============================================================================
// Context
// =============================================================================

// Stable for the provider's lifetime, so a toggle re-renders only the folder
// whose expanded state changed.
interface FileTreeContextValue {
  store: ExpandedPathsStore;
  toggleExpanded: (path: string) => void;
}

const FileTreeContext = createContext<FileTreeContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface FileTreeProviderProps {
  workspaceId: string;
  children: React.ReactNode;
}

export function FileTreeProvider({ workspaceId, children }: FileTreeProviderProps) {
  const [expandedPaths, setExpandedPaths] = usePersistedState(
    `${STORAGE_KEY_PREFIX}${workspaceId}`,
    ExpandedPathsSchema,
    NO_EXPANDED_PATHS,
    { encode: (paths) => JSON.stringify([...paths]) }
  );
  const [store] = useState(() => createExpandedPathsStore(expandedPaths));
  useLayoutEffect(() => store.set(expandedPaths), [store, expandedPaths]);

  const toggleExpanded = useCallback(
    (path: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
    },
    [setExpandedPaths]
  );

  const value = useMemo(() => ({ store, toggleExpanded }), [store, toggleExpanded]);

  return <FileTreeContext value={value}>{children}</FileTreeContext>;
}

// =============================================================================
// Hook
// =============================================================================

/** Whether `path` is expanded; re-renders only when that answer changes. */
export function useFileTreeExpansion(path: string): {
  expanded: boolean;
  toggle: () => void;
} {
  const context = useContext(FileTreeContext);
  if (!context) {
    throw new Error('useFileTreeExpansion must be used within a FileTreeProvider');
  }
  const { store, toggleExpanded } = context;
  const expanded = useSyncExternalStore(store.subscribe, () => store.get().has(path));
  const toggle = useCallback(() => toggleExpanded(path), [toggleExpanded, path]);
  return { expanded, toggle };
}
