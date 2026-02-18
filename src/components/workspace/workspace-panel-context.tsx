import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';
import { useIsMobile } from '@/hooks/use-mobile';

import {
  getScrollStateFromRecord,
  loadScrollStateRecord,
  removeScrollStatesForTab,
  type ScrollMode,
  type ScrollState,
  saveScrollStateRecord,
  upsertScrollState,
} from './scroll-state';

// =============================================================================
// Types
// =============================================================================

export type BottomPanelTab = 'terminal' | 'dev-logs' | 'setup-logs';

export interface MainViewTab {
  id: string;
  type: 'chat' | 'file' | 'diff' | 'screenshot';
  path?: string; // for file/diff tabs
  label: string;
}

export interface WorkspacePanelState {
  tabs: MainViewTab[]; // Always has at least 'chat' tab
  activeTabId: string;
  rightPanelVisible: boolean;
  activeBottomTab: BottomPanelTab;
}

interface WorkspacePanelContextValue extends WorkspacePanelState {
  openTab: (type: MainViewTab['type'], path?: string, label?: string) => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
  setActiveBottomTab: (tab: BottomPanelTab) => void;
  getScrollState: (tabId: string, mode: ScrollMode) => ScrollState | null;
  setScrollState: (tabId: string, mode: ScrollMode, state: ScrollState) => void;
  clearScrollState: (tabId: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY_RIGHT_PANEL_PREFIX = 'workspace-panel-right-visible-';
const STORAGE_KEY_TABS_PREFIX = 'workspace-panel-tabs-';
const STORAGE_KEY_ACTIVE_TAB_PREFIX = 'workspace-panel-active-tab-';
const STORAGE_KEY_BOTTOM_TAB_PREFIX = 'workspace-panel-bottom-tab-';
const STORAGE_KEY_BOTTOM_TAB_OLD_PREFIX = 'workspace-right-panel-bottom-tab-'; // Old key for migration

const CHAT_TAB: MainViewTab = {
  id: 'chat',
  type: 'chat',
  label: 'Chat',
};

const MainViewTabSchema = z
  .object({
    id: z.string(),
    type: z.enum(['chat', 'file', 'diff', 'screenshot']),
    path: z.string().optional(),
    label: z.string(),
  })
  .superRefine((tab, context) => {
    if ((tab.type === 'file' || tab.type === 'diff') && (!tab.path || tab.path.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'File and diff tabs require a path',
        path: ['path'],
      });
    }
  });

const MainViewTabsSchema = z.array(MainViewTabSchema);

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
    const parsed: unknown = JSON.parse(stored);
    const validated = MainViewTabsSchema.safeParse(parsed);
    if (!validated.success) {
      return [CHAT_TAB];
    }
    const tabs = validated.data;
    // Ensure chat tab is always first
    const hasChat = tabs.some((tab) => tab.id === 'chat');
    if (!hasChat) {
      return [CHAT_TAB, ...tabs];
    }
    return tabs;
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

function loadBottomTabFromStorage(workspaceId: string): BottomPanelTab {
  if (typeof window === 'undefined') {
    return 'terminal';
  }
  try {
    // Try new key first
    const stored = localStorage.getItem(`${STORAGE_KEY_BOTTOM_TAB_PREFIX}${workspaceId}`);
    if (stored === 'terminal' || stored === 'dev-logs' || stored === 'setup-logs') {
      return stored;
    }

    // Fallback to old key for migration
    const oldStored = localStorage.getItem(`${STORAGE_KEY_BOTTOM_TAB_OLD_PREFIX}${workspaceId}`);
    if (oldStored === 'terminal' || oldStored === 'dev-logs') {
      // Migrate to new key
      localStorage.setItem(`${STORAGE_KEY_BOTTOM_TAB_PREFIX}${workspaceId}`, oldStored);
      localStorage.removeItem(`${STORAGE_KEY_BOTTOM_TAB_OLD_PREFIX}${workspaceId}`);
      return oldStored;
    }

    return 'terminal';
  } catch {
    return 'terminal';
  }
}

function loadRightPanelVisibility(workspaceId: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_RIGHT_PANEL_PREFIX}${workspaceId}`);
    return stored === 'true';
  } catch {
    return false;
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
  const isMobile = useIsMobile();
  // Track which workspaceId has completed loading (enables persistence)
  const loadedForWorkspaceRef = useRef<string | null>(null);
  const scrollStatesRef = useRef<Record<string, ScrollState>>({});

  const [tabs, setTabs] = useState<MainViewTab[]>([CHAT_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('chat');
  const [rightPanelVisible, setRightPanelVisibleState] = useState<boolean>(false);
  const [activeBottomTab, setActiveBottomTabState] = useState<BottomPanelTab>('terminal');

  // Load persisted state from localStorage on mount or workspaceId change
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }

    // Load tabs and active tab (workspace-scoped)
    const storedTabs = loadTabsFromStorage(workspaceId);
    const storedActiveTab = loadActiveTabFromStorage(workspaceId);

    setTabs(storedTabs);
    // Ensure active tab exists in tabs, fallback to 'chat'
    const activeExists = storedTabs.some((tab) => tab.id === storedActiveTab);
    setActiveTabId(activeExists ? storedActiveTab : 'chat');

    // Load bottom tab (workspace-scoped)
    setActiveBottomTabState(loadBottomTabFromStorage(workspaceId));

    // Load right panel visibility (workspace-scoped). On mobile we start closed.
    setRightPanelVisibleState(isMobile ? false : loadRightPanelVisibility(workspaceId));

    // Load scroll states (workspace-scoped)
    if (typeof window !== 'undefined') {
      scrollStatesRef.current = loadScrollStateRecord(window.localStorage, workspaceId);
    } else {
      scrollStatesRef.current = {};
    }

    // Mark as loaded at the end of this effect, so persist effect skips the
    // re-render triggered by the setState calls above
    loadedForWorkspaceRef.current = workspaceId;
  }, [workspaceId, isMobile]);

  // Persist tabs and active tab when they change (skip until load is complete)
  useEffect(() => {
    if (loadedForWorkspaceRef.current !== workspaceId) {
      return;
    }
    saveTabsToStorage(workspaceId, tabs);
    saveActiveTabToStorage(workspaceId, activeTabId);
  }, [workspaceId, tabs, activeTabId]);

  // Persist activeBottomTab to localStorage
  useEffect(() => {
    if (loadedForWorkspaceRef.current !== workspaceId) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(`${STORAGE_KEY_BOTTOM_TAB_PREFIX}${workspaceId}`, activeBottomTab);
    } catch {
      // Ignore storage errors
    }
  }, [workspaceId, activeBottomTab]);

  // Persist visibility changes to localStorage
  const setRightPanelVisible = useCallback(
    (visible: boolean) => {
      setRightPanelVisibleState(visible);
      if (typeof window === 'undefined' || isMobile) {
        return;
      }
      try {
        localStorage.setItem(`${STORAGE_KEY_RIGHT_PANEL_PREFIX}${workspaceId}`, String(visible));
      } catch {
        // Ignore storage errors
      }
    },
    [workspaceId, isMobile]
  );

  const toggleRightPanel = useCallback(() => {
    setRightPanelVisible(!rightPanelVisible);
  }, [rightPanelVisible, setRightPanelVisible]);

  const prevIsMobileRef = useRef(isMobile);
  useEffect(() => {
    const switchedToMobile = isMobile && !prevIsMobileRef.current;
    if (switchedToMobile && rightPanelVisible) {
      setRightPanelVisibleState(false);
    }
    prevIsMobileRef.current = isMobile;
  }, [isMobile, rightPanelVisible]);

  const getScrollState = useCallback(
    (tabId: string, mode: ScrollMode) =>
      getScrollStateFromRecord(scrollStatesRef.current, tabId, mode),
    []
  );

  const setScrollState = useCallback(
    (tabId: string, mode: ScrollMode, state: ScrollState) => {
      if (typeof window === 'undefined') {
        return;
      }
      scrollStatesRef.current = upsertScrollState(scrollStatesRef.current, tabId, mode, state);
      try {
        saveScrollStateRecord(window.localStorage, workspaceId, scrollStatesRef.current);
      } catch {
        // Ignore storage errors
      }
    },
    [workspaceId]
  );

  const clearScrollState = useCallback(
    (tabId: string) => {
      if (typeof window === 'undefined') {
        return;
      }
      scrollStatesRef.current = removeScrollStatesForTab(scrollStatesRef.current, tabId);
      try {
        saveScrollStateRecord(window.localStorage, workspaceId, scrollStatesRef.current);
      } catch {
        // Ignore storage errors
      }
    },
    [workspaceId]
  );

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

      clearScrollState(id);
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
    [activeTabId, clearScrollState]
  );

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const setActiveBottomTab = useCallback((tab: BottomPanelTab) => {
    setActiveBottomTabState(tab);
  }, []);

  const value = useMemo<WorkspacePanelContextValue>(
    () => ({
      tabs,
      activeTabId,
      rightPanelVisible,
      activeBottomTab,
      openTab,
      closeTab,
      selectTab,
      toggleRightPanel,
      setRightPanelVisible,
      setActiveBottomTab,
      getScrollState,
      setScrollState,
      clearScrollState,
    }),
    [
      tabs,
      activeTabId,
      rightPanelVisible,
      activeBottomTab,
      openTab,
      closeTab,
      selectTab,
      toggleRightPanel,
      setRightPanelVisible,
      setActiveBottomTab,
      getScrollState,
      setScrollState,
      clearScrollState,
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
