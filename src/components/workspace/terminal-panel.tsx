'use client';

import { Terminal } from 'lucide-react';
import { useCallback, useState } from 'react';

import { cn } from '@/lib/utils';

import { TerminalInstance } from './terminal-instance';
import { TerminalTabBar } from './terminal-tab-bar';
import { useTerminalWebSocket } from './use-terminal-websocket';

// =============================================================================
// Types
// =============================================================================

interface TerminalTab {
  id: string;
  label: string;
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

  // Handle terminal output
  const handleOutput = useCallback(
    (data: string) => {
      setTabs((prev) =>
        prev.map((tab) => (tab.id === activeTabId ? { ...tab, output: tab.output + data } : tab))
      );
    },
    [activeTabId]
  );

  // Handle terminal exit
  const handleExit = useCallback(
    (exitCode: number) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTabId
            ? { ...tab, output: `${tab.output}\r\n[Process exited with code ${exitCode}]\r\n` }
            : tab
        )
      );
    },
    [activeTabId]
  );

  // Handle terminal error
  const handleError = useCallback(
    (message: string) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === activeTabId
            ? { ...tab, output: `${tab.output}\r\n[Error: ${message}]\r\n` }
            : tab
        )
      );
    },
    [activeTabId]
  );

  const {
    connected,
    terminalId: _terminalId,
    create,
    sendInput,
    resize,
  } = useTerminalWebSocket({
    workspaceId,
    onOutput: handleOutput,
    onExit: handleExit,
    onError: handleError,
  });

  // Create new terminal tab
  const handleNewTab = useCallback(() => {
    const id = `term-${Date.now()}`;
    const newTab: TerminalTab = {
      id,
      label: `Terminal ${tabs.length + 1}`,
      output: '',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(id);
    create();
  }, [tabs.length, create]);

  // Close terminal tab
  const handleCloseTab = useCallback(
    (id: string) => {
      setTabs((prev) => prev.filter((tab) => tab.id !== id));
      if (activeTabId === id) {
        setActiveTabId(tabs.length > 1 ? (tabs[tabs.length - 2]?.id ?? null) : null);
      }
    },
    [activeTabId, tabs]
  );

  // Handle terminal input
  const handleData = useCallback(
    (data: string) => {
      sendInput(data);
    },
    [sendInput]
  );

  // Handle terminal resize
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      resize(cols, rows);
    },
    [resize]
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
            output={activeTab.output}
            onData={handleData}
            onResize={handleResize}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}
