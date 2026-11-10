import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import {
  lazy,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { ErrorBoundary } from '@/client/error-boundary';
import { useLatestRef } from '@/client/hooks/use-stable-callback';
import {
  appendToRollingOutput,
  TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_TRUNCATION_MARKER,
} from '@/client/lib/rolling-output';
import { TerminalOutputStream } from '@/client/lib/terminal-output-stream';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TerminalDisconnectBanner } from './terminal-disconnect-banner';
import { TerminalTabBar } from './terminal-tab-bar';
import {
  claimPendingTerminalTab,
  createTerminalRequestId,
  removePendingTerminalTab,
} from './terminal-tab-correlation';
import { useTerminalWebSocket } from './use-terminal-websocket';

// Lazy import to allow xterm.js to use static imports
// xterm.js requires DOM APIs that aren't available during server-side rendering
const TerminalInstance = lazy(() =>
  import('@/client/components/terminal-instance').then((m) => ({ default: m.TerminalInstance }))
);

// =============================================================================
// Types
// =============================================================================

// Identity only: output lives in per-tab streams so a chunk never re-renders.
interface TerminalTab {
  id: string;
  label: string;
  terminalId: string | null; // Server-assigned terminal ID
}

const TERMINAL_ROLLING_OUTPUT_OPTIONS = {
  maxChars: TERMINAL_OUTPUT_MAX_CHARS,
  truncationMarker: TERMINAL_TRUNCATION_MARKER,
};

/** Reconnect: replay each tab's server buffer without changing tab identity. */
function replayReconnectBuffers(
  tabs: TerminalTab[],
  terminals: Array<{ id: string; outputBuffer?: string }>,
  getOutputStream: (tabId: string) => TerminalOutputStream
): void {
  const buffers = new Map(terminals.map((terminal) => [terminal.id, terminal.outputBuffer]));
  for (const tab of tabs) {
    const output = tab.terminalId ? buffers.get(tab.terminalId) : undefined;
    if (output !== undefined) {
      getOutputStream(tab.id).replace(output);
    }
  }
}

function emptyStateDescription(connected: boolean, gaveUp: boolean): string {
  if (connected) {
    return 'Click + to open a new terminal';
  }
  return gaveUp ? 'Disconnected' : 'Connecting…';
}

interface TerminalPanelProps {
  workspaceId: string;
  className?: string;
  /** When true, hides the header (tabs are rendered by parent) */
  hideHeader?: boolean;
  isVisible?: boolean;
  autoCreateWhenEmpty?: boolean;
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

// =============================================================================
// Component
// =============================================================================

export function TerminalPanel({
  workspaceId,
  className,
  hideHeader = false,
  isVisible = true,
  autoCreateWhenEmpty = false,
  onStateChange,
}: TerminalPanelProps) {
  const [hasReceivedTerminalList, setHasReceivedTerminalList] = useState(false);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const tabsRef = useRef<TerminalTab[]>([]);
  const updateTabs = useCallback((action: SetStateAction<TerminalTab[]>) => {
    const next = typeof action === 'function' ? action(tabsRef.current) : action;
    tabsRef.current = next;
    setTabs(next);
  }, []);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const setActiveTabId = useCallback((tabId: string | null) => {
    activeTabIdRef.current = tabId;
    setActiveTabIdState(tabId);
  }, []);

  // Track pending tabs by create request so out-of-order responses attach correctly.
  const pendingTabIdsByRequestRef = useRef<Map<string, string>>(new Map());

  // Buffer output for terminals that haven't been associated with a tab yet
  // This handles the race condition where output arrives before the 'created' message
  const outputBufferRef = useRef<Map<string, string>>(new Map());

  // Output per tab id, kept out of React state. The mounted TerminalInstance
  // subscribes to the active tab's stream; the rest replay on selection.
  const outputStreamsRef = useRef<Map<string, TerminalOutputStream>>(new Map());
  const getOutputStream = useCallback((tabId: string) => {
    let stream = outputStreamsRef.current.get(tabId);
    if (!stream) {
      stream = new TerminalOutputStream();
      outputStreamsRef.current.set(tabId, stream);
    }
    return stream;
  }, []);

  // Handle terminal output - route to correct tab by terminalId
  const handleOutput = useCallback(
    (terminalId: string, data: string) => {
      const tab = tabsRef.current.find((t) => t.terminalId === terminalId);
      if (!tab) {
        // Terminal not yet associated - buffer the output
        const existingBuffer = outputBufferRef.current.get(terminalId) ?? '';
        outputBufferRef.current.set(
          terminalId,
          appendToRollingOutput(existingBuffer, data, TERMINAL_ROLLING_OUTPUT_OPTIONS)
        );
        return;
      }

      // Terminal is associated with a tab - append without a React update
      getOutputStream(tab.id).append(data);
    },
    [getOutputStream]
  );

  // Handle terminal created - associate server terminalId with its requested tab
  const handleCreated = useCallback(
    (terminalId: string, requestId?: string, outputBuffer?: string) => {
      const pendingTabId = claimPendingTerminalTab(pendingTabIdsByRequestRef.current, requestId);
      if (pendingTabId) {
        // Combine output captured server-side before listeners attached with
        // any live output buffered client-side before this message arrived.
        const bufferedOutput = outputBufferRef.current.get(terminalId) ?? '';
        outputBufferRef.current.delete(terminalId);

        getOutputStream(pendingTabId).replace((outputBuffer ?? '') + bufferedOutput);
        updateTabs((prev) =>
          prev.map((tab) => (tab.id === pendingTabId ? { ...tab, terminalId } : tab))
        );

        if (activeTabIdRef.current === pendingTabId) {
          // Notify backend only when this response belongs to the selected tab.
          setActiveRef.current(terminalId);
        }
      } else {
        // The pending tab was closed before creation completed; avoid an orphaned PTY.
        outputBufferRef.current.delete(terminalId);
        destroyRef.current(terminalId);
      }
    },
    [getOutputStream, updateTabs]
  );

  // Handle terminal exit
  const handleExit = useCallback(
    (terminalId: string, exitCode: number) => {
      const tab = tabsRef.current.find((t) => t.terminalId === terminalId);
      if (tab) {
        getOutputStream(tab.id).append(`\r\n[Process exited with code ${exitCode}]\r\n`);
      }
    },
    [getOutputStream]
  );

  // Handle terminal error
  const handleError = useCallback(
    (message: string, requestId?: string) => {
      // Show request-scoped create errors in the tab that initiated them.
      if (requestId) {
        const pendingTabId = claimPendingTerminalTab(pendingTabIdsByRequestRef.current, requestId);
        if (!pendingTabId) {
          return;
        }

        if (tabsRef.current.some((tab) => tab.id === pendingTabId)) {
          getOutputStream(pendingTabId).append(`\r\n[Error: ${message}]\r\n`);
        }
        return;
      }

      // Legacy uncorrelated errors cannot be tied to one create request.
      outputBufferRef.current.clear();
    },
    [getOutputStream]
  );

  // Restore tabs after refresh and replay server output after reconnect.
  const handleTerminalList = useCallback(
    (terminals: Array<{ id: string; createdAt: string; outputBuffer?: string }>) => {
      setHasReceivedTerminalList(true);
      const existingTabs = tabsRef.current;
      if (existingTabs.length > 0) {
        replayReconnectBuffers(existingTabs, terminals, getOutputStream);
        return;
      }

      // Create tabs for each existing terminal, restoring buffered output
      const restoredTabs: TerminalTab[] = terminals.map((terminal, index) => {
        const id = `tab-${terminal.id}`;
        outputStreamsRef.current.set(id, new TerminalOutputStream(terminal.outputBuffer ?? ''));
        return { id, label: `Terminal ${index + 1}`, terminalId: terminal.id };
      });
      updateTabs(restoredTabs);

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
    },
    [getOutputStream, setActiveTabId, updateTabs]
  );

  const { connected, gaveUp, reconnect, create, sendInput, resize, destroy, setActive } =
    useTerminalWebSocket({
      workspaceId,
      onOutput: handleOutput,
      onCreated: handleCreated,
      onExit: handleExit,
      onError: handleError,
      onTerminalList: handleTerminalList,
    });

  // The socket callbacks above are created before the socket, so they reach
  // its commands through these refs.
  const setActiveRef = useLatestRef(setActive);
  const destroyRef = useLatestRef(destroy);

  // A reconnect replays the terminal list before auto-create may run again.
  if (!connected && hasReceivedTerminalList) {
    setHasReceivedTerminalList(false);
  }

  // Create new terminal tab
  const handleNewTab = useCallback(() => {
    if (!connected) {
      return;
    }

    const requestId = createTerminalRequestId();
    const id = `tab-${requestId}`;

    pendingTabIdsByRequestRef.current.set(requestId, id);
    outputStreamsRef.current.set(id, new TerminalOutputStream());
    updateTabs((prev) => [
      ...prev,
      {
        id,
        label: `Terminal ${prev.length + 1}`,
        terminalId: null,
      },
    ]);
    setActiveTabId(id);
    create(requestId);
  }, [connected, create, setActiveTabId, updateTabs]);

  useEffect(() => {
    if (
      autoCreateWhenEmpty &&
      isVisible &&
      connected &&
      hasReceivedTerminalList &&
      tabs.length === 0 &&
      tabsRef.current.length === 0
    ) {
      handleNewTab();
    }
  }, [
    autoCreateWhenEmpty,
    isVisible,
    connected,
    hasReceivedTerminalList,
    tabs.length,
    handleNewTab,
  ]);

  // Close terminal tab
  const handleCloseTab = useCallback(
    (id: string) => {
      updateTabs((prev) => {
        // Find the tab to get its terminalId before removing it
        const tab = prev.find((t) => t.id === id);
        removePendingTerminalTab(pendingTabIdsByRequestRef.current, id);
        outputStreamsRef.current.delete(id);
        if (tab?.terminalId) {
          // Destroy the server-side terminal process
          destroy(tab.terminalId);
          // Clean up any buffered output for this terminal
          outputBufferRef.current.delete(tab.terminalId);
        }

        const filtered = prev.filter((t) => t.id !== id);

        // Update active tab if we're closing the current one
        // Use setTimeout to avoid state update during render
        if (activeTabId === id && filtered.length > 0) {
          const closedIndex = prev.findIndex((t) => t.id === id);
          // Prefer the tab before the closed one, or the first remaining tab
          const newActiveTab = filtered[closedIndex - 1] ?? filtered[0];
          if (!newActiveTab) {
            return filtered;
          }
          setTimeout(() => {
            setActiveTabId(newActiveTab.id);
            // Notify backend of new active terminal
            if (newActiveTab.terminalId) {
              setActive(newActiveTab.terminalId);
            }
          }, 0);
        } else if (activeTabId === id) {
          setTimeout(() => {
            if (activeTabIdRef.current === id) {
              setActiveTabId(null);
            }
          }, 0);
        }

        return filtered;
      });
    },
    [activeTabId, destroy, setActive, setActiveTabId, updateTabs]
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
    [tabs, setActive, setActiveTabId]
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

  // Restoring or creating the first terminal should not show a manual-create prompt.
  if (tabs.length === 0 && autoCreateWhenEmpty && !gaveUp) {
    return <Loading size="compact" message={connected ? 'Opening terminal…' : 'Connecting…'} />;
  }

  // Empty state
  if (tabs.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={TerminalIcon}
        title="No terminal open"
        description={emptyStateDescription(connected, gaveUp)}
        action={
          gaveUp ? (
            <Button variant="outline" size="sm" onClick={reconnect}>
              Reconnect
            </Button>
          ) : null
        }
        className={cn('h-full bg-background', className)}
      />
    );
  }

  return (
    <div className={cn('h-full flex flex-col', className)}>
      {/* Input sent while disconnected is dropped, so make the gap visible */}
      {!connected && <TerminalDisconnectBanner gaveUp={gaveUp} onReconnect={reconnect} />}
      {/* Terminal tabs row - only show if not hidden */}
      {!hideHeader && (
        <div className="flex items-center gap-1.5 px-2 py-1 bg-background border-b border-border">
          <TerminalTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
          />
        </div>
      )}

      {/* Terminal content */}
      <div className="flex-1 overflow-hidden bg-background">
        {activeTab && isVisible && (
          <ErrorBoundary
            variant="compact"
            title="Couldn't load the terminal"
            resetKey={activeTab.id}
          >
            <Suspense fallback={<Loading size="compact" message="Loading terminal…" />}>
              <TerminalInstance
                key={activeTab.id}
                output={getOutputStream(activeTab.id)}
                onData={handleData}
                onResize={handleResize}
                className="h-full"
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
