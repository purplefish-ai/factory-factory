import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';
import type { SubagentSelection } from '@/client/features/subagents';
import { MOBILE_BREAKPOINT, useIsMobile } from '@/hooks/use-mobile';
import { subagentSummarySchema } from '@/shared/acp-protocol';
import type { TopPanelTab } from './right-panel-state';
import {
  getScrollStateFromRecord,
  loadScrollStateRecord,
  removeScrollStatesForTab,
  type ScrollMode,
  type ScrollState,
  saveScrollStateRecord,
  upsertScrollState,
} from './scroll-state';
import { useRightPanelTopTab } from './use-right-panel-top-tab';

// =============================================================================
// Types
// =============================================================================

export type BottomPanelTab = 'terminal' | 'dev-logs' | 'post-run-logs' | 'setup-logs';

export interface MainViewTab {
  id: string;
  type: 'chat' | 'file' | 'diff' | 'screenshot' | 'closed-session' | 'subagent';
  path?: string; // for file/diff/screenshot tabs
  closedSessionId?: string; // for closed-session tabs
  subagentSelection?: SubagentSelection;
  label: string;
}

export interface WorkspacePanelState {
  tabs: MainViewTab[]; // Always has at least 'chat' tab
  activeTabId: string;
  rightPanelVisible: boolean;
  activeBottomTab: BottomPanelTab;
  activeTopTab: TopPanelTab;
}

interface WorkspacePanelContextValue extends WorkspacePanelState {
  openTab: (type: Exclude<MainViewTab['type'], 'subagent'>, path?: string, label?: string) => void;
  openSubagentTab: (selection: SubagentSelection) => void;
  updateSubagentTab: (selection: SubagentSelection) => void;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
  setActiveBottomTab: (tab: BottomPanelTab) => void;
  setActiveTopTab: (tab: TopPanelTab) => void;
  scrollLoadedWorkspaceId: string | null;
  createScrollStateWriter: (tabId: string, mode: ScrollMode) => (state: ScrollState) => void;
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

const SubagentSelectionSchema = z.object({
  parentSessionId: z.string().min(1),
  parentSessionName: z.string(),
  subagent: subagentSummarySchema,
});

const MainViewTabSchema = z
  .object({
    id: z.string(),
    type: z.enum(['chat', 'file', 'diff', 'screenshot', 'closed-session', 'subagent']),
    path: z.string().optional(),
    closedSessionId: z.string().optional(),
    subagentSelection: SubagentSelectionSchema.optional(),
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
    if (tab.type === 'subagent' && !tab.subagentSelection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Sub-agent tabs require a selection snapshot',
        path: ['subagentSelection'],
      });
    }
  });

const MainViewTabsSchema = z.array(MainViewTabSchema);
const MOBILE_MAX_WIDTH_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
const SCROLL_STATE_PERSIST_DEBOUNCE_MS = 120;

// =============================================================================
// Helper Functions
// =============================================================================

function getSubagentTabLabel(selection: SubagentSelection): string {
  return selection.subagent.name?.trim() || `Sub-agent ${selection.subagent.id.slice(0, 8)}`;
}

function getSubagentTabId(selection: SubagentSelection): string {
  return `subagent-${selection.parentSessionId}-${selection.subagent.id}`;
}

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
    if (
      stored === 'terminal' ||
      stored === 'dev-logs' ||
      stored === 'post-run-logs' ||
      stored === 'setup-logs'
    ) {
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
    return true;
  }
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY_RIGHT_PANEL_PREFIX}${workspaceId}`);
    // Default to expanded if no preference stored
    if (stored === null) {
      return true;
    }
    return stored === 'true';
  } catch {
    return true;
  }
}

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.matchMedia(MOBILE_MAX_WIDTH_MEDIA_QUERY).matches;
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
  initialActiveTabId?: string;
}

export function WorkspacePanelProvider({
  workspaceId,
  children,
  initialActiveTabId,
}: WorkspacePanelProviderProps) {
  const isMobile = useIsMobile();
  const { activeTopTab, setActiveTopTab } = useRightPanelTopTab(workspaceId);
  // Track which workspaceId has completed loading (enables persistence)
  const loadedForWorkspaceRef = useRef<string | null>(null);
  const scrollStatesRef = useRef<Record<string, ScrollState>>({});
  const scrollPersistTimeoutRef = useRef<number | null>(null);
  const pendingScrollPersistRef = useRef<{
    workspaceId: string;
    record: Record<string, ScrollState>;
  } | null>(null);
  const [scrollLoadedWorkspaceId, setScrollLoadedWorkspaceId] = useState<string | null>(null);
  const scrollScopeRef = useRef<{ workspaceId: string; revisions: Map<string, number> } | null>(
    null
  );
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [tabs, setTabs] = useState<MainViewTab[]>([CHAT_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('chat');
  const [rightPanelVisible, setRightPanelVisibleState] = useState<boolean>(false);
  const [activeBottomTab, setActiveBottomTabState] = useState<BottomPanelTab>('terminal');

  const flushPendingScrollPersist = useCallback(() => {
    const pending = pendingScrollPersistRef.current;
    if (!(typeof window !== 'undefined' && pending)) {
      return;
    }
    try {
      saveScrollStateRecord(window.localStorage, pending.workspaceId, pending.record);
    } catch {
      // Ignore storage errors
    }
    pendingScrollPersistRef.current = null;
  }, []);

  // Load persisted state from localStorage on mount or workspaceId change
  useEffect(() => {
    if (loadedForWorkspaceRef.current === workspaceId) {
      return;
    }

    // Finish the previous workspace before replacing its in-memory record.
    if (scrollPersistTimeoutRef.current !== null) {
      clearTimeout(scrollPersistTimeoutRef.current);
      scrollPersistTimeoutRef.current = null;
    }
    flushPendingScrollPersist();
    scrollScopeRef.current = { workspaceId, revisions: new Map() };

    // Load tabs and active tab (workspace-scoped)
    const storedTabs = loadTabsFromStorage(workspaceId);
    const storedActiveTab = initialActiveTabId ?? loadActiveTabFromStorage(workspaceId);

    setTabs(storedTabs);
    // Ensure active tab exists in tabs, fallback to 'chat'
    const activeExists = storedTabs.some((tab) => tab.id === storedActiveTab);
    setActiveTabId(activeExists ? storedActiveTab : 'chat');

    // Load bottom tab (workspace-scoped)
    setActiveBottomTabState(loadBottomTabFromStorage(workspaceId));

    // Load right panel visibility (workspace-scoped). On mobile we start closed.
    setRightPanelVisibleState(isMobileViewport() ? false : loadRightPanelVisibility(workspaceId));

    // Load scroll states (workspace-scoped)
    try {
      scrollStatesRef.current =
        typeof window === 'undefined'
          ? {}
          : loadScrollStateRecord(window.localStorage, workspaceId);
    } catch {
      scrollStatesRef.current = {};
    }

    // Mark as loaded at the end of this effect, so persist effect skips the
    // re-render triggered by the setState calls above
    loadedForWorkspaceRef.current = workspaceId;
    setScrollLoadedWorkspaceId(workspaceId);
  }, [workspaceId, initialActiveTabId, flushPendingScrollPersist]);

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
    const switchedToDesktop = !isMobile && prevIsMobileRef.current;
    if (switchedToMobile && rightPanelVisible) {
      setRightPanelVisibleState(false);
    }
    if (switchedToDesktop) {
      setRightPanelVisibleState(loadRightPanelVisibility(workspaceId));
    }
    prevIsMobileRef.current = isMobile;
  }, [isMobile, rightPanelVisible, workspaceId]);

  const scheduleScrollPersist = useCallback(
    (record: Record<string, ScrollState>) => {
      if (typeof window === 'undefined') {
        return;
      }
      pendingScrollPersistRef.current = {
        workspaceId,
        record,
      };
      if (scrollPersistTimeoutRef.current !== null) {
        clearTimeout(scrollPersistTimeoutRef.current);
      }
      scrollPersistTimeoutRef.current = window.setTimeout(() => {
        scrollPersistTimeoutRef.current = null;
        flushPendingScrollPersist();
      }, SCROLL_STATE_PERSIST_DEBOUNCE_MS);
    },
    [flushPendingScrollPersist, workspaceId]
  );

  useEffect(
    () => () => {
      if (scrollPersistTimeoutRef.current !== null) {
        clearTimeout(scrollPersistTimeoutRef.current);
        scrollPersistTimeoutRef.current = null;
      }
      flushPendingScrollPersist();
    },
    [flushPendingScrollPersist]
  );

  // Capture the loaded record itself, so A callbacks also stay revoked after A/B/A.
  const scrollScope = scrollScopeRef.current;
  const isCurrentScrollScope = useCallback(
    () =>
      mountedRef.current &&
      scrollScope !== null &&
      scrollScope.workspaceId === workspaceId &&
      scrollScopeRef.current === scrollScope,
    [scrollScope, workspaceId]
  );

  const getScrollState = useCallback(
    (tabId: string, mode: ScrollMode) =>
      isCurrentScrollScope()
        ? getScrollStateFromRecord(scrollStatesRef.current, tabId, mode)
        : null,
    [isCurrentScrollScope]
  );

  const setScrollState = useCallback(
    (tabId: string, mode: ScrollMode, state: ScrollState) => {
      if (typeof window === 'undefined' || !isCurrentScrollScope()) {
        return;
      }
      scrollStatesRef.current = upsertScrollState(scrollStatesRef.current, tabId, mode, state);
      scheduleScrollPersist(scrollStatesRef.current);
    },
    [isCurrentScrollScope, scheduleScrollPersist]
  );

  const createScrollStateWriter = useCallback(
    (tabId: string, mode: ScrollMode) => {
      const revision = scrollScope?.revisions.get(tabId) ?? 0;
      return (state: ScrollState) => {
        if (revision !== (scrollScope?.revisions.get(tabId) ?? 0)) {
          return;
        }
        setScrollState(tabId, mode, state);
      };
    },
    [scrollScope, setScrollState]
  );

  const clearScrollState = useCallback(
    (tabId: string) => {
      if (typeof window === 'undefined' || !isCurrentScrollScope()) {
        return;
      }
      scrollScope?.revisions.set(tabId, (scrollScope.revisions.get(tabId) ?? 0) + 1);
      scrollStatesRef.current = removeScrollStatesForTab(scrollStatesRef.current, tabId);
      scheduleScrollPersist(scrollStatesRef.current);
    },
    [isCurrentScrollScope, scheduleScrollPersist, scrollScope]
  );

  const openTab = useCallback(
    (type: Exclude<MainViewTab['type'], 'subagent'>, path?: string, label?: string) => {
      // Check for existing tab
      const existing = tabs.find((tab) => {
        if (type === 'closed-session' && path) {
          return tab.type === 'closed-session' && tab.closedSessionId === path;
        }
        if ((type === 'file' || type === 'diff' || type === 'screenshot') && path) {
          return tab.type === type && tab.path === path;
        }
        return false;
      });

      if (existing) {
        setActiveTabId(existing.id);
        return;
      }

      // Create new tab
      const id = `${type}-${path ?? Date.now()}`;
      const tabLabel = label ?? (path ? (path.split('/').pop() ?? path) : type);

      const newTab: MainViewTab = {
        id,
        type,
        path: type === 'file' || type === 'diff' || type === 'screenshot' ? path : undefined,
        closedSessionId: type === 'closed-session' ? path : undefined,
        label: tabLabel,
      };

      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(id);
    },
    [tabs]
  );

  const openSubagentTab = useCallback((selection: SubagentSelection) => {
    const id = getSubagentTabId(selection);
    setTabs((current) => {
      const existing = current.some((tab) => tab.id === id && tab.type === 'subagent');
      const refreshed = current.map((tab) =>
        tab.id === id
          ? { ...tab, label: getSubagentTabLabel(selection), subagentSelection: selection }
          : tab
      );
      return existing
        ? refreshed
        : [
            ...current,
            {
              id,
              type: 'subagent',
              label: getSubagentTabLabel(selection),
              subagentSelection: selection,
            },
          ];
    });
    setActiveTabId(id);
  }, []);

  const updateSubagentTab = useCallback((selection: SubagentSelection) => {
    const id = getSubagentTabId(selection);
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id && tab.type === 'subagent'
          ? { ...tab, label: getSubagentTabLabel(selection), subagentSelection: selection }
          : tab
      )
    );
  }, []);

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
      activeTopTab,
      openTab,
      openSubagentTab,
      updateSubagentTab,
      closeTab,
      selectTab,
      toggleRightPanel,
      setRightPanelVisible,
      setActiveBottomTab,
      setActiveTopTab,
      scrollLoadedWorkspaceId,
      createScrollStateWriter,
      getScrollState,
      setScrollState,
      clearScrollState,
    }),
    [
      tabs,
      activeTabId,
      rightPanelVisible,
      activeBottomTab,
      activeTopTab,
      openTab,
      openSubagentTab,
      updateSubagentTab,
      closeTab,
      selectTab,
      toggleRightPanel,
      setRightPanelVisible,
      setActiveBottomTab,
      setActiveTopTab,
      scrollLoadedWorkspaceId,
      createScrollStateWriter,
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
