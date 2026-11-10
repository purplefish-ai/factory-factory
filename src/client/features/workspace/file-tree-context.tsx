import { createContext, useCallback, useContext, useMemo } from 'react';
import { z } from 'zod';
import { usePersistedState } from '@/client/hooks/use-persisted-state';

// =============================================================================
// Types
// =============================================================================

interface FileTreeContextValue {
  expandedPaths: Set<string>;
  isExpanded: (path: string) => boolean;
  toggleExpanded: (path: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_PREFIX = 'file-tree-expanded-';

const ExpandedPathsSchema = z.array(z.string()).transform((paths) => new Set(paths));
const NO_EXPANDED_PATHS = new Set<string>();

// =============================================================================
// Context
// =============================================================================

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

  const isExpanded = useCallback((path: string) => expandedPaths.has(path), [expandedPaths]);

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

  const value = useMemo<FileTreeContextValue>(
    () => ({
      expandedPaths,
      isExpanded,
      toggleExpanded,
    }),
    [expandedPaths, isExpanded, toggleExpanded]
  );

  return <FileTreeContext.Provider value={value}>{children}</FileTreeContext.Provider>;
}

// =============================================================================
// Hook
// =============================================================================

export function useFileTreeExpansion(): FileTreeContextValue {
  const context = useContext(FileTreeContext);
  if (!context) {
    throw new Error('useFileTreeExpansion must be used within a FileTreeProvider');
  }
  return context;
}
