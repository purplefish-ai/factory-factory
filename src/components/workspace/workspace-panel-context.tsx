'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

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

const STORAGE_KEY = 'workspace-panel-right-visible';

const CHAT_TAB: MainViewTab = {
  id: 'chat',
  type: 'chat',
  label: 'Chat',
};

// =============================================================================
// Context
// =============================================================================

const WorkspacePanelContext = createContext<WorkspacePanelContextValue | null>(null);

// =============================================================================
// Provider
// =============================================================================

interface WorkspacePanelProviderProps {
  children: React.ReactNode;
}

export function WorkspacePanelProvider({ children }: WorkspacePanelProviderProps) {
  const [tabs, setTabs] = useState<MainViewTab[]>([CHAT_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('chat');
  const [rightPanelVisible, setRightPanelVisibleState] = useState<boolean>(false);

  // Load persisted visibility from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      setRightPanelVisibleState(stored === 'true');
    }
  }, []);

  // Persist visibility changes to localStorage
  const setRightPanelVisible = useCallback((visible: boolean) => {
    setRightPanelVisibleState(visible);
    localStorage.setItem(STORAGE_KEY, String(visible));
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
