import { lazy, Suspense } from 'react';
import { ErrorBoundary } from '@/client/error-boundary';
import { SubagentTranscriptView } from '@/client/features/subagents';
import { cn } from '@/lib/utils';
import { ClosedSessionTranscriptView } from './closed-session-transcript-view';
import { ScreenshotViewerTab } from './screenshot-viewer-tab';
import { useWorkspacePanel } from './workspace-panel-context';

const DiffViewer = lazy(() =>
  import('./diff-viewer').then((module) => ({ default: module.DiffViewer }))
);
const FileViewer = lazy(() =>
  import('./file-viewer').then((module) => ({ default: module.FileViewer }))
);

// =============================================================================
// Main Component
// =============================================================================

interface MainViewContentProps {
  workspaceId: string;
  children: React.ReactNode; // The existing chat content
  className?: string;
}

export function MainViewContent({ workspaceId, children, className }: MainViewContentProps) {
  const { tabs, activeTabId } = useWorkspacePanel();

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  // Determine what's visible
  const showChat = !activeTab || activeTab.type === 'chat';
  const filePath = activeTab?.type === 'file' ? activeTab.path : undefined;
  const diffPath = activeTab?.type === 'diff' ? activeTab.path : undefined;
  const screenshotPath = activeTab?.type === 'screenshot' ? activeTab.path : undefined;
  const closedSessionId =
    activeTab?.type === 'closed-session' ? activeTab.closedSessionId : undefined;
  const subagentSelection =
    activeTab?.type === 'subagent' ? activeTab.subagentSelection : undefined;
  const activeTabKey = activeTab?.id;

  return (
    <div className={cn('h-full', className)}>
      {/* Always render chat children but hide when not active.
          This prevents unmounting/remounting which causes state loss. */}
      <div className={cn('h-full', !showChat && 'hidden')}>{children}</div>
      <ErrorBoundary
        key={activeTabKey}
        fallback={
          <div role="alert" className="p-4 text-sm text-destructive">
            Unable to load viewer. Reload the app to try again.
          </div>
        }
      >
        <Suspense
          fallback={
            <div role="status" className="p-4 text-sm text-muted-foreground">
              Loading viewer…
            </div>
          }
        >
          {filePath && activeTabKey && (
            <FileViewer
              key={activeTabKey}
              workspaceId={workspaceId}
              filePath={filePath}
              tabId={activeTabKey}
            />
          )}
          {diffPath && activeTabKey && (
            <DiffViewer
              key={activeTabKey}
              workspaceId={workspaceId}
              filePath={diffPath}
              tabId={activeTabKey}
            />
          )}
        </Suspense>
      </ErrorBoundary>
      {screenshotPath && activeTabKey && (
        <ScreenshotViewerTab
          workspaceId={workspaceId}
          screenshotPath={screenshotPath}
          tabId={activeTabKey}
        />
      )}
      {closedSessionId && <ClosedSessionTranscriptView sessionId={closedSessionId} />}
      {subagentSelection && activeTabKey && (
        <SubagentTranscriptView
          key={activeTabKey}
          workspaceId={workspaceId}
          selection={subagentSelection}
        />
      )}
    </div>
  );
}
