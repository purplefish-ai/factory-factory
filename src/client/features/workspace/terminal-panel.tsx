import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { lazy, Suspense } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { ErrorBoundary } from '@/client/error-boundary';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TerminalDisconnectBanner } from './terminal-disconnect-banner';
import type { TerminalTabs } from './use-terminal-tabs';

// Lazy import to allow xterm.js to use static imports
// xterm.js requires DOM APIs that aren't available during server-side rendering
const TerminalInstance = lazy(() =>
  import('@/client/components/terminal-instance').then((m) => ({ default: m.TerminalInstance }))
);

function emptyStateDescription(connected: boolean, gaveUp: boolean): string {
  if (connected) {
    return 'Click + to open a new terminal';
  }
  return gaveUp ? 'Disconnected' : 'Connecting…';
}

interface TerminalPanelProps {
  /** Tabs from useTerminalTabs, called by the component that renders the tab bar. */
  terminal: TerminalTabs;
  className?: string;
  isVisible?: boolean;
  /** An empty panel is opening its first terminal, so show progress instead of a prompt. */
  autoCreateWhenEmpty?: boolean;
}

/** The active terminal of `terminal`, or its empty and disconnected states. */
export function TerminalPanel({
  terminal,
  className,
  isVisible = true,
  autoCreateWhenEmpty = false,
}: TerminalPanelProps) {
  const { tabs, activeTabId, connected, gaveUp, reconnect } = terminal;
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
                output={terminal.getOutputStream(activeTab.id)}
                onData={terminal.sendInput}
                onResize={terminal.resize}
                className="h-full"
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
