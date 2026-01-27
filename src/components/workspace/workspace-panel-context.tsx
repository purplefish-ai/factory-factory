'use client';

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

export interface MainViewTab {
  id: string;
  type: 'chat' | 'file' | 'diff';
  path?: string; // for file/diff tabs
  label: string;
}

export interface WorkspacePanelState {
  tabs: MainViewTab[]; // Always has at least 'chat' tab
  activeTabId: string;
  rightPanelVisible: boolean;
}

interface WorkspacePanelContextValue extends WorkspacePanelState {
  openTab: (type: MainViewTab['type'], path?: string, label?: string) => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
}

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_RIGHT_PANEL = 'workspace-panel-right-visible';
const STORAGE_KEY_TABS_PREFIX = 'workspace-panel-tabs-';
const STORAGE_KEY_ACTIVE_TAB_PREFIX = 'workspace-panel-active-tab-';

const CHAT_TAB: MainViewTab = {
  id: 'chat',
  type: 'chat',
  label: 'Chat',
};

// =============================================================================
// Helper Functions
// =============================================================================

function loadTabsFromStorage(workspaceId: string): MainViewTab[] {
  if (typeof window === 'undefined') {
    return [CHAT_TAB];
  }
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_TABS_PREFIX}${workspaceId}`);
    if (!stored) {
      return [CHAT_TAB];
    }
    const parsed = JSON.parse(stored) as MainViewTab[];
    // Ensure chat tab is always first
    const hasChat = parsed.some((tab) => tab.id === 'chat');
    if (!hasChat) {
      return [CHAT_TAB, ...parsed];
    }
    return parsed;
  } catch {
    return [CHAT_TAB];
  }
}

function loadActiveTabFromStorage(workspaceId: string): string {
  if (typeof window === 'undefined') {
    return 'chat';
  }
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_ACTIVE_TAB_PREFIX}${workspaceId}`);
    return stored ?? 'chat';
  } catch {
    return 'chat';
  }
}

function saveTabsToStorage(workspaceId: string, tabs: MainViewTab[]): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(`${STORAGE_KEY_TABS_PREFIX}${workspaceId}`, JSON.stringify(tabs));
  } catch {
    // Ignore storage errors (quota, private browsing, etc.)
  }
}

function saveActiveTabToStorage(workspaceId: string, activeTabId: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(`${STORAGE_KEY_ACTIVE_TAB_PREFIX}${workspaceId}`, activeTabId);
  } catch {
    // Ignore storage errors
  }
}

// =============================================================================
// Context
// =============================================================================

const WorkspacePanelContext = createContext<WorkspacePanelContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface WorkspacePanelProviderProps {
  workspaceId: string;
  children: React.ReactNode;
}

export function WorkspacePanelProvider({ workspaceId, children }: WorkspacePanelProviderProps) {
  // Track if initial load from localStorage has happened
  const initializedRef = useRef(false);

  const [tabs, setTabs] = useState<MainViewTab[]>([CHAT_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('chat');
  const [rightPanelVisible, setRightPanelVisibleState] = useState<boolean>(false);

  // Load persisted state from localStorage on mount
  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Load tabs and active tab (workspace-scoped)
    const storedTabs = loadTabsFromStorage(workspaceId);
    const storedActiveTab = loadActiveTabFromStorage(workspaceId);

    setTabs(storedTabs);
    // Ensure active tab exists in tabs, fallback to 'chat'
    const activeExists = storedTabs.some((tab) => tab.id === storedActiveTab);
    setActiveTabId(activeExists ? storedActiveTab : 'chat');

    // Load right panel visibility (global)
    const stored = localStorage.getItem(STORAGE_KEY_RIGHT_PANEL);
    if (stored !== null) {
      setRightPanelVisibleState(stored === 'true');
    }
  }, [workspaceId]);

  // Persist tabs when they change (skip initial render)
  useEffect(() => {
    if (!initializedRef.current) {
      return;
    }
    saveTabsToStorage(workspaceId, tabs);
  }, [workspaceId, tabs]);

  // Persist active tab when it changes (skip initial render)
  useEffect(() => {
    if (!initializedRef.current) {
      return;
    }
    saveActiveTabToStorage(workspaceId, activeTabId);
  }, [workspaceId, activeTabId]);

  // Persist visibility changes to localStorage
  const setRightPanelVisible = useCallback((visible: boolean) => {
    setRightPanelVisibleState(visible);
    localStorage.setItem(STORAGE_KEY_RIGHT_PANEL, String(visible));
  }, []);

  const toggleRightPanel = useCallback(() => {
    setRightPanelVisible(!rightPanelVisible);
  }, [rightPanelVisible, setRightPanelVisible]);

  const openTab = useCallback(
    (type: MainViewTab['type'], path?: string, label?: string) => {
      // For file/diff tabs, check if one with the same path already exists
      if (path) {
        const existing = tabs.find((tab) => tab.type === type && tab.path === path);
        if (existing) {
          setActiveTabId(existing.id);
          return;
        }
      }

      // Generate a unique ID for the new tab
      const id = `${type}-${path ?? Date.now()}`;

      // Generate label if not provided
      const tabLabel = label ?? (path ? (path.split('/').pop() ?? path) : type);

      const newTab: MainViewTab = {
        id,
        type,
        path,
        label: tabLabel,
      };

      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(id);
    },
    [tabs]
  );

  const closeTab = useCallback(
    (id: string) => {
      // Prevent closing the chat tab
      if (id === 'chat') {
        return;
      }

      setTabs((prev) => {
        const newTabs = prev.filter((tab) => tab.id !== id);

        // If we closed the active tab, switch to another one
        if (activeTabId === id) {
          const closedIndex = prev.findIndex((tab) => tab.id === id);
          // Prefer the tab to the left, or the chat tab
          const newActiveTab = newTabs[closedIndex - 1] ?? newTabs[0] ?? CHAT_TAB;
          setActiveTabId(newActiveTab.id);
        }

        return newTabs;
      });
    },
    [activeTabId]
  );

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const value = useMemo<WorkspacePanelContextValue>(
    () => ({
      tabs,
      activeTabId,
      rightPanelVisible,
      openTab,
      closeTab,
      selectTab,
      toggleRightPanel,
      setRightPanelVisible,
    }),
    [
      tabs,
      activeTabId,
      rightPanelVisible,
      openTab,
      closeTab,
      selectTab,
      toggleRightPanel,
      setRightPanelVisible,
    ]
  );

  return <WorkspacePanelContext.Provider value={value}>{children}</WorkspacePanelContext.Provider>;
}

// =============================================================================
// Hook
// =============================================================================

export function useWorkspacePanel(): WorkspacePanelContextValue {
  const context = useContext(WorkspacePanelContext);
  if (!context) {
    throw new Error('useWorkspacePanel must be used within a WorkspacePanelProvider');
  }
  return context;
}
