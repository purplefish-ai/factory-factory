import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLatestRef, useStableCallback } from '@/client/hooks/use-stable-callback';
import {
  appendToRollingOutput,
  TERMINAL_OUTPUT_MAX_CHARS,
  TERMINAL_TRUNCATION_MARKER,
} from '@/client/lib/rolling-output';
import { TerminalOutputStream } from '@/client/lib/terminal-output-stream';
import {
  claimPendingTerminalTab,
  createTerminalRequestId,
  removePendingTerminalTab,
} from './terminal-tab-correlation';
import { useTerminalWebSocket } from './use-terminal-websocket';

// Identity only: output lives in per-tab streams so a chunk never re-renders.
interface TerminalTab {
  id: string;
  label: string;
  terminalId: string | null; // Server-assigned terminal ID
}

interface TerminalTabsSnapshot {
  tabs: TerminalTab[];
  activeTabId: string | null;
}

/** Terminal tabs and their socket, owned by the panel that renders the tab bar. */
export interface TerminalTabs extends TerminalTabsSnapshot {
  connected: boolean;
  gaveUp: boolean;
  reconnect: () => void;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  newTab: () => void;
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  /** The tab's output, kept outside React state; created on first read. */
  getOutputStream: (tabId: string) => TerminalOutputStream;
}

const TERMINAL_ROLLING_OUTPUT_OPTIONS = {
  maxChars: TERMINAL_OUTPUT_MAX_CHARS,
  truncationMarker: TERMINAL_TRUNCATION_MARKER,
};

/**
 * Socket callbacks read and update the tabs between renders, so the tabs live
 * in a store they can read synchronously; React renders its snapshots.
 */
function createTabsStore() {
  let snapshot: TerminalTabsSnapshot = { tabs: [], activeTabId: null };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    update: (next: Partial<TerminalTabsSnapshot>) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

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

/**
 * Terminal tabs for a workspace: restores the server's terminals, creates and
 * closes them, and routes output to per-tab streams. With `autoCreate`, an
 * empty list opens a first terminal once the server's list has arrived.
 */
export function useTerminalTabs({
  workspaceId,
  autoCreate,
}: {
  workspaceId: string;
  autoCreate: boolean;
}): TerminalTabs {
  const [store] = useState(createTabsStore);
  const { tabs, activeTabId } = useSyncExternalStore(store.subscribe, store.get);
  const [hasReceivedTerminalList, setHasReceivedTerminalList] = useState(false);

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

  const findTab = (terminalId: string) =>
    store.get().tabs.find((tab) => tab.terminalId === terminalId);

  const socket = useTerminalWebSocket({
    workspaceId,
    // Route output to its tab by terminalId, without a React update.
    onOutput: useStableCallback((terminalId: string, data: string) => {
      const tab = findTab(terminalId);
      if (tab) {
        getOutputStream(tab.id).append(data);
        return;
      }
      // Terminal not yet associated - buffer the output
      const existingBuffer = outputBufferRef.current.get(terminalId) ?? '';
      outputBufferRef.current.set(
        terminalId,
        appendToRollingOutput(existingBuffer, data, TERMINAL_ROLLING_OUTPUT_OPTIONS)
      );
    }),
    // Associate the server terminalId with the tab that requested it.
    onCreated: useStableCallback(
      (terminalId: string, requestId?: string, outputBuffer?: string) => {
        const pendingTabId = claimPendingTerminalTab(pendingTabIdsByRequestRef.current, requestId);
        // Combine output captured server-side before listeners attached with
        // any live output buffered client-side before this message arrived.
        const bufferedOutput = outputBufferRef.current.get(terminalId) ?? '';
        outputBufferRef.current.delete(terminalId);
        if (!pendingTabId) {
          // The pending tab was closed before creation completed; avoid an orphaned PTY.
          socketRef.current.destroy(terminalId);
          return;
        }
        getOutputStream(pendingTabId).replace((outputBuffer ?? '') + bufferedOutput);
        const { tabs: current, activeTabId: active } = store.get();
        store.update({
          tabs: current.map((tab) => (tab.id === pendingTabId ? { ...tab, terminalId } : tab)),
        });
        if (active === pendingTabId) {
          // Notify backend only when this response belongs to the selected tab.
          socketRef.current.setActive(terminalId);
        }
      }
    ),
    onExit: useStableCallback((terminalId: string, exitCode: number) => {
      const tab = findTab(terminalId);
      if (tab) {
        getOutputStream(tab.id).append(`\r\n[Process exited with code ${exitCode}]\r\n`);
      }
    }),
    onError: useStableCallback((message: string, requestId?: string) => {
      // Legacy uncorrelated errors cannot be tied to one create request.
      if (!requestId) {
        outputBufferRef.current.clear();
        return;
      }
      // Show request-scoped create errors in the tab that initiated them.
      const pendingTabId = claimPendingTerminalTab(pendingTabIdsByRequestRef.current, requestId);
      if (pendingTabId && store.get().tabs.some((tab) => tab.id === pendingTabId)) {
        getOutputStream(pendingTabId).append(`\r\n[Error: ${message}]\r\n`);
      }
    }),
    // Restore tabs after refresh and replay server output after reconnect.
    onTerminalList: useStableCallback(
      (terminals: Array<{ id: string; createdAt: string; outputBuffer?: string }>) => {
        setHasReceivedTerminalList(true);
        const existingTabs = store.get().tabs;
        if (existingTabs.length > 0) {
          replayReconnectBuffers(existingTabs, terminals, getOutputStream);
          return;
        }
        const restoredTabs = terminals.map((terminal, index) => {
          const id = `tab-${terminal.id}`;
          outputStreamsRef.current.set(id, new TerminalOutputStream(terminal.outputBuffer ?? ''));
          return { id, label: `Terminal ${index + 1}`, terminalId: terminal.id };
        });
        const first = restoredTabs[0];
        store.update({ tabs: restoredTabs, activeTabId: first?.id ?? null });
        if (first) {
          socketRef.current.setActive(first.terminalId);
        }
      }
    ),
  });
  // The socket callbacks above are created before the socket, so they reach
  // its commands through this ref.
  const socketRef = useLatestRef(socket);
  const { connected } = socket;

  // A reconnect replays the terminal list before auto-create may run again.
  if (!connected && hasReceivedTerminalList) {
    setHasReceivedTerminalList(false);
  }

  const newTab = useStableCallback(() => {
    if (!connected) {
      return;
    }
    const requestId = createTerminalRequestId();
    const id = `tab-${requestId}`;
    pendingTabIdsByRequestRef.current.set(requestId, id);
    outputStreamsRef.current.set(id, new TerminalOutputStream());
    const current = store.get().tabs;
    store.update({
      tabs: [...current, { id, label: `Terminal ${current.length + 1}`, terminalId: null }],
      activeTabId: id,
    });
    socket.create(requestId);
  });

  useEffect(() => {
    // The store may already hold a tab the next render will show.
    if (
      autoCreate &&
      connected &&
      hasReceivedTerminalList &&
      tabs.length === 0 &&
      store.get().tabs.length === 0
    ) {
      newTab();
    }
  }, [autoCreate, connected, hasReceivedTerminalList, tabs.length, store]);

  const closeTab = useStableCallback((tabId: string) => {
    const { tabs: current, activeTabId: active } = store.get();
    const tab = current.find((candidate) => candidate.id === tabId);
    removePendingTerminalTab(pendingTabIdsByRequestRef.current, tabId);
    outputStreamsRef.current.delete(tabId);
    if (tab?.terminalId) {
      // Destroy the server-side terminal process and any output buffered for it.
      socket.destroy(tab.terminalId);
      outputBufferRef.current.delete(tab.terminalId);
    }
    const remaining = current.filter((candidate) => candidate.id !== tabId);
    if (active !== tabId) {
      store.update({ tabs: remaining });
      return;
    }
    // Prefer the tab before the closed one, or the first remaining tab.
    const closedIndex = current.findIndex((candidate) => candidate.id === tabId);
    const nextActive = remaining[closedIndex - 1] ?? remaining[0];
    store.update({ tabs: remaining, activeTabId: nextActive?.id ?? null });
    if (nextActive?.terminalId) {
      socket.setActive(nextActive.terminalId);
    }
  });

  const selectTab = useStableCallback((tabId: string) => {
    store.update({ activeTabId: tabId });
    const tab = store.get().tabs.find((candidate) => candidate.id === tabId);
    if (tab?.terminalId) {
      socket.setActive(tab.terminalId);
    }
  });

  const activeTerminalId = () => {
    const snapshot = store.get();
    return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)?.terminalId;
  };
  const sendInput = useStableCallback((data: string) => {
    const terminalId = activeTerminalId();
    if (terminalId) {
      socket.sendInput(terminalId, data);
    }
  });
  const resize = useStableCallback((cols: number, rows: number) => {
    const terminalId = activeTerminalId();
    if (terminalId) {
      socket.resize(terminalId, cols, rows);
    }
  });

  return {
    tabs,
    activeTabId,
    connected,
    gaveUp: socket.gaveUp,
    reconnect: socket.reconnect,
    selectTab,
    closeTab,
    newTab,
    sendInput,
    resize,
    getOutputStream,
  };
}
