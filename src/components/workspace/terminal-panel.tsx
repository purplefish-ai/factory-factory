import { Terminal } from 'lucide-react';
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

import { TerminalTabBar } from './terminal-tab-bar';
import { useTerminalWebSocket } from './use-terminal-websocket';

// Lazy import to allow xterm.js to use static imports
// xterm.js requires DOM APIs that aren't available during server-side rendering
const TerminalInstance = lazy(() =>
  import('./terminal-instance').then((m) => ({ default: m.TerminalInstance }))
);

// =============================================================================
// Types
// =============================================================================

interface TerminalTab {
  id: string;
  label: string;
  terminalId: string | null; // Server-assigned terminal ID
  output: string;
}

interface TerminalPanelProps {
  workspaceId: string;
  className?: string;
  /** When true, hides the header (tabs are rendered by parent) */
  hideHeader?: boolean;
  /** Callback to notify parent of tab state changes for inline rendering */
  onStateChange?: (state: TerminalTabState) => void;
}

/** State interface for controlling terminal tabs from parent */
export interface TerminalTabState {
  tabs: Array<{ id: string; label: string }>;
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

export interface TerminalPanelRef {
  createNewTerminal: () => void;
}

function removePendingRequestForTab(pendingTabIds: Map<string, string>, tabId: string): void {
  for (const [requestId, pendingTabId] of pendingTabIds) {
    if (pendingTabId === tabId) {
      pendingTabIds.delete(requestId);
      return;
    }
  }
}

function getActiveTabAfterClose(
  previousTabs: TerminalTab[],
  remainingTabs: TerminalTab[],
  closedTabId: string
): TerminalTab | undefined {
  const closedIndex = previousTabs.findIndex((tab) => tab.id === closedTabId);
  return remainingTabs[closedIndex - 1] ?? remainingTabs[0];
}

// =============================================================================
// Component
// =============================================================================

export const TerminalPanel = forwardRef<TerminalPanelRef, TerminalPanelProps>(
  function TerminalPanel({ workspaceId, className, hideHeader = false, onStateChange }, ref) {
    const [tabs, setTabs] = useState<TerminalTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);

    // Track pending tabs waiting for terminalIds from the server.
    const pendingTabIdsRef = useRef<Map<string, string>>(new Map());
    const terminalTabIdsRef = useRef<Map<string, string>>(new Map());
    const createRequestCounterRef = useRef(0);

    // Buffer output for terminals that haven't been associated with a tab yet
    // This handles the race condition where output arrives before the 'created' message
    const outputBufferRef = useRef<Map<string, string>>(new Map());

    // Ref to hold setActive function to break circular dependency with callbacks
    const setActiveRef = useRef<(terminalId: string) => void>(() => undefined);
    const destroyRef = useRef<(terminalId: string) => void>(() => undefined);

    // Handle terminal output - route to correct tab by terminalId
    const handleOutput = useCallback((terminalId: string, data: string) => {
      const tabId = terminalTabIdsRef.current.get(terminalId);
      if (!tabId) {
        // Terminal not yet associated - buffer the output
        const existingBuffer = outputBufferRef.current.get(terminalId) ?? '';
        outputBufferRef.current.set(terminalId, existingBuffer + data);
        return;
      }

      setTabs((prev) =>
        prev.map((tab) => (tab.id === tabId ? { ...tab, output: tab.output + data } : tab))
      );
    }, []);

    // Handle terminal created - associate server terminalId with its requested tab
    const handleCreated = useCallback(
      (terminalId: string, requestId?: string) => {
        let pendingTabId: string | undefined;
        if (requestId) {
          pendingTabId = pendingTabIdsRef.current.get(requestId);
          pendingTabIdsRef.current.delete(requestId);
        } else if (pendingTabIdsRef.current.size === 1) {
          const fallbackEntry = pendingTabIdsRef.current.entries().next().value;
          if (fallbackEntry) {
            const [fallbackRequestId, fallbackTabId] = fallbackEntry;
            pendingTabId = fallbackTabId;
            pendingTabIdsRef.current.delete(fallbackRequestId);
          }
        }

        if (!pendingTabId) {
          outputBufferRef.current.delete(terminalId);
          destroyRef.current(terminalId);
          return;
        }

        // Get any buffered output for this terminal
        const bufferedOutput = outputBufferRef.current.get(terminalId) ?? '';
        outputBufferRef.current.delete(terminalId);
        terminalTabIdsRef.current.set(terminalId, pendingTabId);

        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === pendingTabId ? { ...tab, terminalId, output: bufferedOutput } : tab
          )
        );

        if (pendingTabId === activeTabId) {
          setActiveRef.current(terminalId);
        }
      },
      [activeTabId]
    );

    // Handle terminal exit
    const handleExit = useCallback((terminalId: string, exitCode: number) => {
      const tabId = terminalTabIdsRef.current.get(terminalId);
      if (!tabId) {
        return;
      }
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, output: `${tab.output}\r\n[Process exited with code ${exitCode}]\r\n` }
            : tab
        )
      );
    }, []);

    // Handle terminal error
    const handleError = useCallback((message: string, requestId?: string) => {
      let pendingTabId: string | undefined;
      if (requestId) {
        pendingTabId = pendingTabIdsRef.current.get(requestId);
        pendingTabIdsRef.current.delete(requestId);
      } else if (pendingTabIdsRef.current.size === 1) {
        const fallbackEntry = pendingTabIdsRef.current.entries().next().value;
        if (fallbackEntry) {
          const [fallbackRequestId, fallbackTabId] = fallbackEntry;
          pendingTabId = fallbackTabId;
          pendingTabIdsRef.current.delete(fallbackRequestId);
        }
      }

      if (pendingTabId) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === pendingTabId
              ? { ...tab, output: `${tab.output}\r\n[Error: ${message}]\r\n` }
              : tab
          )
        );
      }

      if (!requestId) {
        outputBufferRef.current.clear();
      }
    }, []);

    // Handle terminal list restoration (after page refresh)
    const handleTerminalList = useCallback(
      (terminals: Array<{ id: string; createdAt: string; outputBuffer?: string }>) => {
        // Only restore if we don't already have tabs (avoid duplicates on reconnect)
        setTabs((prev) => {
          if (prev.length > 0) {
            return prev;
          }

          // Create tabs for each existing terminal, restoring buffered output
          const restoredTabs: TerminalTab[] = terminals.map((terminal, index) => ({
            id: `tab-${terminal.id}`,
            label: `Terminal ${index + 1}`,
            terminalId: terminal.id,
            output: terminal.outputBuffer ?? '',
          }));

          for (const tab of restoredTabs) {
            if (tab.terminalId) {
              terminalTabIdsRef.current.set(tab.terminalId, tab.id);
            }
          }

          // Set the first tab as active
          if (restoredTabs.length > 0 && restoredTabs[0]?.terminalId) {
            const firstTerminalId = restoredTabs[0]?.terminalId;
            const firstTabId = restoredTabs[0]?.id;
            setTimeout(() => {
              setActiveTabId(firstTabId ?? null);
              // Notify backend of active terminal
              setActiveRef.current(firstTerminalId);
            }, 0);
          }

          return restoredTabs;
        });
      },
      []
    );

    const { connected, create, sendInput, resize, destroy, setActive } = useTerminalWebSocket({
      workspaceId,
      onOutput: handleOutput,
      onCreated: handleCreated,
      onExit: handleExit,
      onError: handleError,
      onTerminalList: handleTerminalList,
    });

    // Update ref so callbacks can access setActive
    setActiveRef.current = setActive;
    destroyRef.current = destroy;

    // Create new terminal tab - extracted so it can be exposed via ref
    const handleNewTab = useCallback(() => {
      createRequestCounterRef.current += 1;
      const requestId = `terminal-create-${Date.now()}-${createRequestCounterRef.current}`;
      const id = `tab-${requestId}`;

      pendingTabIdsRef.current.set(requestId, id);

      setTabs((prev) => [
        ...prev,
        {
          id,
          label: `Terminal ${prev.length + 1}`,
          terminalId: null,
          output: '',
        },
      ]);
      setActiveTabId(id);
      create(80, 24, requestId);
    }, [create]);

    // Expose createNewTerminal to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        createNewTerminal: handleNewTab,
      }),
      [handleNewTab]
    );

    // Close terminal tab
    const handleCloseTab = useCallback(
      (id: string) => {
        setTabs((prev) => {
          const tab = prev.find((t) => t.id === id);
          if (tab?.terminalId) {
            destroy(tab.terminalId);
            outputBufferRef.current.delete(tab.terminalId);
            terminalTabIdsRef.current.delete(tab.terminalId);
          } else {
            removePendingRequestForTab(pendingTabIdsRef.current, id);
          }

          const filtered = prev.filter((t) => t.id !== id);
          if (activeTabId !== id) {
            return filtered;
          }

          const newActiveTab = getActiveTabAfterClose(prev, filtered, id);
          setTimeout(() => {
            setActiveTabId(newActiveTab?.id ?? null);
            if (newActiveTab?.terminalId) {
              setActive(newActiveTab.terminalId);
            }
          }, 0);

          return filtered;
        });
      },
      [activeTabId, destroy, setActive]
    );

    // Handle terminal input - send to the active tab's terminal
    const handleData = useCallback(
      (data: string) => {
        const activeTab = tabs.find((tab) => tab.id === activeTabId);
        if (activeTab?.terminalId) {
          sendInput(activeTab.terminalId, data);
        }
      },
      [activeTabId, tabs, sendInput]
    );

    // Handle terminal resize - resize the active tab's terminal
    const handleResize = useCallback(
      (cols: number, rows: number) => {
        const activeTab = tabs.find((tab) => tab.id === activeTabId);
        if (activeTab?.terminalId) {
          resize(activeTab.terminalId, cols, rows);
        }
      },
      [activeTabId, tabs, resize]
    );

    // Handle tab selection - update local state and notify backend
    const handleSelectTab = useCallback(
      (tabId: string) => {
        setActiveTabId(tabId);
        const tab = tabs.find((t) => t.id === tabId);
        if (tab?.terminalId) {
          setActive(tab.terminalId);
        }
      },
      [tabs, setActive]
    );

    // Notify parent of state changes for inline tab rendering
    const stateForParent = useMemo(
      () => ({
        tabs: tabs.map((t) => ({ id: t.id, label: t.label })),
        activeTabId,
        onSelectTab: handleSelectTab,
        onCloseTab: handleCloseTab,
        onNewTab: handleNewTab,
      }),
      [tabs, activeTabId, handleSelectTab, handleCloseTab, handleNewTab]
    );

    useEffect(() => {
      onStateChange?.(stateForParent);
    }, [stateForParent, onStateChange]);

    const activeTab = tabs.find((tab) => tab.id === activeTabId);

    // Empty state
    if (tabs.length === 0) {
      return (
        <div
          className={cn(
            'h-full flex flex-col items-center justify-center text-center p-4 bg-zinc-900',
            className
          )}
        >
          <Terminal className="h-10 w-10 text-zinc-500 mb-3" />
          <p className="text-sm font-medium text-zinc-400">No terminal open</p>
          <p className="text-xs text-zinc-500 mt-1">
            {connected ? 'Click + to open a new terminal' : 'Connecting...'}
          </p>
        </div>
      );
    }

    return (
      <div className={cn('h-full flex flex-col', className)}>
        {/* Terminal tabs row - only show if not hidden */}
        {!hideHeader && (
          <div className="flex items-center gap-1.5 px-2 py-1 bg-zinc-900 border-b border-zinc-800">
            <TerminalTabBar
              tabs={tabs}
              activeTabId={activeTabId}
              onSelectTab={handleSelectTab}
              onCloseTab={handleCloseTab}
              showNewButton={false}
            />
          </div>
        )}

        {/* Terminal content */}
        <div className="flex-1 overflow-hidden bg-zinc-900">
          {activeTab && (
            <Suspense
              fallback={
                <div className="h-full flex items-center justify-center text-zinc-500">
                  Loading terminal...
                </div>
              }
            >
              <TerminalInstance
                key={activeTab.id}
                output={activeTab.output}
                onData={handleData}
                onResize={handleResize}
                className="h-full"
                isActive
              />
            </Suspense>
          )}
        </div>
      </div>
    );
  }
);
