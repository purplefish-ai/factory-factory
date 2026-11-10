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
import { usePersistedState } from '@/client/hooks/use-persisted-state';
import { useWorkspaceDrawer } from '@/client/hooks/use-workspace-drawer';
import { localStore, readStorageItem } from '@/client/lib/browser-storage';
import { subagentSummarySchema } from '@/shared/acp-protocol';
import {
  STORAGE_KEY_TOP_TAB_PREFIX,
  StoredTopTabSchema,
  type TopPanelTab,
} from './right-panel-state';
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
  mobilePanel: 'top' | 'bottom';
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
  subagent: subagentSummarySchema
    .omit({ stopControl: true })
    .transform(({ stopControl: _discardedControl, ...snapshot }) => snapshot),
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
        message: 'Subagent tabs require a selection snapshot',
        path: ['subagentSelection'],
      });
    }
  });

const MainViewTabsSchema = z.array(MainViewTabSchema);
const SCROLL_STATE_PERSIST_DEBOUNCE_MS = 120;

// =============================================================================
// Helper Functions
// =============================================================================

function getSubagentTabLabel(selection: SubagentSelection): string {
  return selection.subagent.name?.trim() || `Subagent ${selection.subagent.id.slice(0, 8)}`;
}

function getSubagentTabId(selection: SubagentSelection): string {
  return `subagent-${selection.parentSessionId}-${selection.subagent.id}`;
}

/** Restores generated labels of unnamed legacy tabs and keeps the chat tab first. */
function normalizeStoredTabs(stored: MainViewTab[]): MainViewTab[] {
  const tabs = stored.map((tab) => {
    const selection = tab.subagentSelection;
    if (
      tab.type === 'subagent' &&
      selection &&
      !selection.subagent.name?.trim() &&
      tab.label === `Sub-agent ${selection.subagent.id.slice(0, 8)}`
    ) {
      return { ...tab, label: getSubagentTabLabel(selection) };
    }
    return tab;
  });
  return tabs.some((tab) => tab.id === 'chat') ? tabs : [CHAT_TAB, ...tabs];
}

const StoredTabsSchema = MainViewTabsSchema.transform(normalizeStoredTabs);
const DEFAULT_TABS = [CHAT_TAB];

/** Stores tabs without live fields such as sub-agent stop controls. */
function encodeTabs(tabs: MainViewTab[]): string {
  return JSON.stringify(MainViewTabsSchema.parse(tabs));
}

const BottomPanelTabSchema = z.enum(['terminal', 'dev-logs', 'post-run-logs', 'setup-logs']);

/** The bottom tab saved under the key used before post-run and setup logs existed. */
function readLegacyBottomTab(workspaceId: string): BottomPanelTab {
  const legacy = z
    .enum(['terminal', 'dev-logs'])
    .safeParse(readStorageItem(`${STORAGE_KEY_BOTTOM_TAB_OLD_PREFIX}${workspaceId}`));
  return legacy.success ? legacy.data : 'terminal';
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

/** Panel state belongs to one workspace; a different workspace remounts it. */
export function WorkspacePanelProvider(props: WorkspacePanelProviderProps) {
  return <WorkspacePanelState key={props.workspaceId} {...props} />;
}

function WorkspacePanelState({
  workspaceId,
  children,
  initialActiveTabId,
}: WorkspacePanelProviderProps) {
  const isMobile = useWorkspaceDrawer();
  const [activeTopTab, selectTopTab] = usePersistedState(
    `${STORAGE_KEY_TOP_TAB_PREFIX}${workspaceId}`,
    StoredTopTabSchema,
    'changes',
    { format: 'text' }
  );
  const [mobilePanel, setMobilePanel] = useState<'top' | 'bottom'>('top');
  const setActiveTopTab = useCallback(
    (tab: TopPanelTab) => {
      setMobilePanel('top');
      selectTopTab(tab);
    },
    [selectTopTab]
  );
  const [initialScrollStates] = useState(() => loadScrollStateRecord(localStore, workspaceId));
  const scrollStatesRef = useRef<Record<string, ScrollState>>(initialScrollStates);
  const scrollPersistTimeoutRef = useRef<number | null>(null);
  const pendingScrollPersistRef = useRef<Record<string, ScrollState> | null>(null);
  const [scrollRevisions] = useState(() => new Map<string, number>());
  // Viewer callbacks outlive an unmount; revoke them so they cannot write.
  const revokedRef = useRef(false);
  useLayoutEffect(() => {
    revokedRef.current = false;
    return () => {
      revokedRef.current = true;
    };
  }, []);

  const [tabs, setTabs] = usePersistedState<MainViewTab[]>(
    `${STORAGE_KEY_TABS_PREFIX}${workspaceId}`,
    StoredTabsSchema,
    DEFAULT_TABS,
    { encode: encodeTabs }
  );
  const [storedActiveTabId, setStoredActiveTabId] = usePersistedState(
    `${STORAGE_KEY_ACTIVE_TAB_PREFIX}${workspaceId}`,
    z.string(),
    'chat',
    { format: 'text' }
  );
  // A link to a session opens chat for this visit; the next selection is stored.
  const [linkedTabId, setLinkedTabId] = useState(initialActiveTabId);
  const requestedTabId = linkedTabId ?? storedActiveTabId;
  const activeTabId = tabs.some((tab) => tab.id === requestedTabId) ? requestedTabId : 'chat';
  const setActiveTabId = useCallback(
    (id: string) => {
      setLinkedTabId(undefined);
      setStoredActiveTabId(id);
    },
    [setStoredActiveTabId]
  );
  const legacyBottomTab = useMemo(() => readLegacyBottomTab(workspaceId), [workspaceId]);
  const [activeBottomTab, setActiveBottomTabState] = usePersistedState(
    `${STORAGE_KEY_BOTTOM_TAB_PREFIX}${workspaceId}`,
    BottomPanelTabSchema,
    legacyBottomTab,
    { format: 'text' }
  );
  // The desktop preference is stored; the mobile drawer always starts closed.
  const [storedRightPanelVisible, setStoredRightPanelVisible] = usePersistedState(
    `${STORAGE_KEY_RIGHT_PANEL_PREFIX}${workspaceId}`,
    z.boolean(),
    true
  );
  const [mobileRightPanelVisible, setMobileRightPanelVisible] = useState(false);
  const rightPanelVisible = isMobile ? mobileRightPanelVisible : storedRightPanelVisible;

  const flushPendingScrollPersist = useCallback(() => {
    const pending = pendingScrollPersistRef.current;
    if (pending) {
      saveScrollStateRecord(localStore, workspaceId, pending);
      pendingScrollPersistRef.current = null;
    }
  }, [workspaceId]);

  const setRightPanelVisible = useCallback(
    (visible: boolean) => {
      if (isMobile) {
        setMobileRightPanelVisible(visible);
      } else {
        setStoredRightPanelVisible(visible);
      }
    },
    [isMobile, setStoredRightPanelVisible]
  );

  const toggleRightPanel = useCallback(() => {
    setRightPanelVisible(!rightPanelVisible);
  }, [rightPanelVisible, setRightPanelVisible]);

  // Entering the mobile layout starts with its right panel closed.
  const [panelLayoutIsMobile, setPanelLayoutIsMobile] = useState(isMobile);
  if (panelLayoutIsMobile !== isMobile) {
    setPanelLayoutIsMobile(isMobile);
    if (isMobile) {
      setMobileRightPanelVisible(false);
    }
  }

  const scheduleScrollPersist = useCallback(
    (record: Record<string, ScrollState>) => {
      pendingScrollPersistRef.current = record;
      if (scrollPersistTimeoutRef.current !== null) {
        clearTimeout(scrollPersistTimeoutRef.current);
      }
      scrollPersistTimeoutRef.current = window.setTimeout(() => {
        scrollPersistTimeoutRef.current = null;
        flushPendingScrollPersist();
      }, SCROLL_STATE_PERSIST_DEBOUNCE_MS);
    },
    [flushPendingScrollPersist]
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

  const getScrollState = useCallback(
    (tabId: string, mode: ScrollMode) =>
      revokedRef.current ? null : getScrollStateFromRecord(scrollStatesRef.current, tabId, mode),
    []
  );

  const setScrollState = useCallback(
    (tabId: string, mode: ScrollMode, state: ScrollState) => {
      if (revokedRef.current) {
        return;
      }
      scrollStatesRef.current = upsertScrollState(scrollStatesRef.current, tabId, mode, state);
      scheduleScrollPersist(scrollStatesRef.current);
    },
    [scheduleScrollPersist]
  );

  const createScrollStateWriter = useCallback(
    (tabId: string, mode: ScrollMode) => {
      const revision = scrollRevisions.get(tabId) ?? 0;
      return (state: ScrollState) => {
        if (revision !== (scrollRevisions.get(tabId) ?? 0)) {
          return;
        }
        setScrollState(tabId, mode, state);
      };
    },
    [scrollRevisions, setScrollState]
  );

  const clearScrollState = useCallback(
    (tabId: string) => {
      if (revokedRef.current) {
        return;
      }
      scrollRevisions.set(tabId, (scrollRevisions.get(tabId) ?? 0) + 1);
      scrollStatesRef.current = removeScrollStatesForTab(scrollStatesRef.current, tabId);
      scheduleScrollPersist(scrollStatesRef.current);
    },
    [scheduleScrollPersist, scrollRevisions]
  );

  const openTab = useCallback(
    (type: Exclude<MainViewTab['type'], 'subagent'>, path?: string, label?: string) => {
      if (isMobile) {
        setMobileRightPanelVisible(false);
      }
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
    [tabs, isMobile, setTabs, setActiveTabId]
  );

  const openSubagentTab = useCallback(
    (selection: SubagentSelection) => {
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
    },
    [setTabs, setActiveTabId]
  );

  const updateSubagentTab = useCallback(
    (selection: SubagentSelection) => {
      const id = getSubagentTabId(selection);
      setTabs((current) =>
        current.map((tab) =>
          tab.id === id && tab.type === 'subagent'
            ? { ...tab, label: getSubagentTabLabel(selection), subagentSelection: selection }
            : tab
        )
      );
    },
    [setTabs]
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
    [activeTabId, clearScrollState, setTabs, setActiveTabId]
  );

  const selectTab = useCallback(
    (id: string) => {
      setActiveTabId(id);
    },
    [setActiveTabId]
  );

  const setActiveBottomTab = useCallback(
    (tab: BottomPanelTab) => {
      setActiveBottomTabState(tab);
      setMobilePanel('bottom');
    },
    [setActiveBottomTabState]
  );

  const value = useMemo<WorkspacePanelContextValue>(
    () => ({
      tabs,
      activeTabId,
      rightPanelVisible,
      activeBottomTab,
      activeTopTab,
      mobilePanel,
      openTab,
      openSubagentTab,
      updateSubagentTab,
      closeTab,
      selectTab,
      toggleRightPanel,
      setRightPanelVisible,
      setActiveBottomTab,
      setActiveTopTab,
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
      mobilePanel,
      openTab,
      openSubagentTab,
      updateSubagentTab,
      closeTab,
      selectTab,
      toggleRightPanel,
      setRightPanelVisible,
      setActiveBottomTab,
      setActiveTopTab,
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
