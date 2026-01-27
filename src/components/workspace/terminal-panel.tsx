'use client';

import { Terminal } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { TerminalTabBar } from './terminal-tab-bar';
import { useTerminalWebSocket } from './use-terminal-websocket';

// Dynamic import with SSR disabled to allow xterm.js to use static imports
// xterm.js requires DOM APIs that aren't available during server-side rendering
const TerminalInstance = dynamic(
  () => import('./terminal-instance').then((m) => ({ default: m.TerminalInstance })),
  { ssr: false }
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
}

// =============================================================================
// Component
// =============================================================================

export function TerminalPanel({ workspaceId, className }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Track pending tab that's waiting for a terminalId from the server
  const pendingTabIdRef = useRef<string | null>(null);

  // Buffer output for terminals that haven't been associated with a tab yet
  // This handles the race condition where output arrives before the 'created' message
  const outputBufferRef = useRef<Map<string, string>>(new Map());

  // Handle terminal output - route to correct tab by terminalId
  const handleOutput = useCallback((terminalId: string, data: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.terminalId === terminalId);
      if (tab) {
        // Terminal is associated with a tab - append output
        return prev.map((t) =>
          t.terminalId === terminalId ? { ...t, output: t.output + data } : t
        );
      }
      // Terminal not yet associated - buffer the output
      const existingBuffer = outputBufferRef.current.get(terminalId) ?? '';
      outputBufferRef.current.set(terminalId, existingBuffer + data);
      return prev;
    });
  }, []);

  // Handle terminal created - associate server terminalId with pending tab
  const handleCreated = useCallback((terminalId: string) => {
    const pendingTabId = pendingTabIdRef.current;
    if (pendingTabId) {
      // Get any buffered output for this terminal
      const bufferedOutput = outputBufferRef.current.get(terminalId) ?? '';
      outputBufferRef.current.delete(terminalId);

      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === pendingTabId ? { ...tab, terminalId, output: bufferedOutput } : tab
        )
      );
      pendingTabIdRef.current = null;
    }
  }, []);

  // Handle terminal exit
  const handleExit = useCallback((terminalId: string, exitCode: number) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.terminalId === terminalId
          ? { ...tab, output: `${tab.output}\r\n[Process exited with code ${exitCode}]\r\n` }
          : tab
      )
    );
  }, []);

  // Handle terminal error
  const handleError = useCallback((message: string) => {
    // Show error in pending tab if there is one
    const pendingTabId = pendingTabIdRef.current;
    if (pendingTabId) {
      // Clear the pending tab ref since creation failed
      pendingTabIdRef.current = null;

      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === pendingTabId
            ? { ...tab, output: `${tab.output}\r\n[Error: ${message}]\r\n` }
            : tab
        )
      );
    }

    // Clear any orphaned buffer entries that won't be claimed
    // This prevents memory leaks when terminal creation fails
    outputBufferRef.current.clear();
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

        // Set the first tab as active
        if (restoredTabs.length > 0) {
          setTimeout(() => setActiveTabId(restoredTabs[0].id), 0);
        }

        return restoredTabs;
      });
    },
    []
  );

  const { connected, create, sendInput, resize, destroy } = useTerminalWebSocket({
    workspaceId,
    onOutput: handleOutput,
    onCreated: handleCreated,
    onExit: handleExit,
    onError: handleError,
    onTerminalList: handleTerminalList,
  });

  // Create new terminal tab
  const handleNewTab = useCallback(() => {
    const id = `tab-${Date.now()}`;
    const newTab: TerminalTab = {
      id,
      label: `Terminal ${tabs.length + 1}`,
      terminalId: null,
      output: '',
    };

    // Track this as the pending tab waiting for a terminalId
    pendingTabIdRef.current = id;

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    create();
  }, [tabs.length, create]);

  // Close terminal tab
  const handleCloseTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        // Find the tab to get its terminalId before removing it
        const tab = prev.find((t) => t.id === id);
        if (tab?.terminalId) {
          // Destroy the server-side terminal process
          destroy(tab.terminalId);
          // Clean up any buffered output for this terminal
          outputBufferRef.current.delete(tab.terminalId);
        }

        const filtered = prev.filter((t) => t.id !== id);

        // Update active tab if we're closing the current one
        // Use setTimeout to avoid state update during render
        if (activeTabId === id) {
          const closedIndex = prev.findIndex((t) => t.id === id);
          // Prefer the tab before the closed one, or the first remaining tab
          const newActiveTab = filtered[closedIndex - 1] ?? filtered[0];
          setTimeout(() => setActiveTabId(newActiveTab?.id ?? null), 0);
        }

        return filtered;
      });
    },
    [activeTabId, destroy]
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

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  // Empty state
  if (tabs.length === 0) {
    return (
      <div className={cn('h-full flex flex-col', className)}>
        {/* Header */}
        <div className="flex items-center justify-between gap-1.5 px-3 py-2 bg-muted/50 border-b">
          <div className="flex items-center gap-1.5">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">Terminal</span>
          </div>
          <TerminalTabBar
            tabs={[]}
            activeTabId={null}
            onSelectTab={() => {
              /* noop for empty state */
            }}
            onCloseTab={() => {
              /* noop for empty state */
            }}
            onNewTab={handleNewTab}
          />
        </div>

        {/* Empty state content */}
        <div className="flex-1 flex flex-col items-center justify-center text-center p-4 bg-zinc-900">
          <Terminal className="h-10 w-10 text-zinc-500 mb-3" />
          <p className="text-sm font-medium text-zinc-400">No terminal open</p>
          <p className="text-xs text-zinc-500 mt-1">
            {connected ? 'Click + to open a new terminal' : 'Connecting...'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('h-full flex flex-col', className)}>
      {/* Header with tabs */}
      <div className="flex items-center justify-between gap-1.5 px-3 py-2 bg-muted/50 border-b">
        <div className="flex items-center gap-1.5">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">Terminal</span>
        </div>
        <TerminalTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
        />
      </div>

      {/* Terminal content */}
      <div className="flex-1 overflow-hidden bg-zinc-900">
        {activeTab && (
          <TerminalInstance
            key={activeTab.id}
            output={activeTab.output}
            onData={handleData}
            onResize={handleResize}
            className="h-full"
            isActive
          />
        )}
      </div>
    </div>
  );
}
