import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

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

// =============================================================================
// Helper Functions
// =============================================================================

function loadExpandedPathsFromStorage(workspaceId: string): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_PREFIX}${workspaceId}`);
    if (!stored) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(stored);
    if (!(Array.isArray(parsed) && parsed.every((item) => typeof item === 'string'))) {
      return new Set();
    }
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function saveExpandedPathsToStorage(workspaceId: string, expandedPaths: Set<string>): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${workspaceId}`, JSON.stringify([...expandedPaths]));
  } catch {
    // Ignore storage errors (quota, private browsing, etc.)
  }
}

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
  // Track which workspaceId has completed loading (enables persistence)
  const loadedForWorkspaceRef = useRef<string | null>(null);
  // Track the previous workspaceId to detect workspace switches
  const prevWorkspaceIdRef = useRef<string | null>(null);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  // Load persisted state from localStorage on mount or workspaceId change
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }

    const storedPaths = loadExpandedPathsFromStorage(workspaceId);
    setExpandedPaths(storedPaths);

    // Mark as loaded at the end of this effect
    loadedForWorkspaceRef.current = workspaceId;
  }, [workspaceId]);

  // Persist expanded paths when they change (skip until load is complete)
  // Also skip on workspace switch to avoid saving stale state from previous workspace
  useEffect(() => {
    if (loadedForWorkspaceRef.current !== workspaceId) {
      return;
    }
    // Skip saving if workspace just changed (expandedPaths still contains old workspace's data)
    if (prevWorkspaceIdRef.current !== null && prevWorkspaceIdRef.current !== workspaceId) {
      prevWorkspaceIdRef.current = workspaceId;
      return;
    }
    prevWorkspaceIdRef.current = workspaceId;
    saveExpandedPathsToStorage(workspaceId, expandedPaths);
  }, [workspaceId, expandedPaths]);

  const isExpanded = useCallback((path: string) => expandedPaths.has(path), [expandedPaths]);

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

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
