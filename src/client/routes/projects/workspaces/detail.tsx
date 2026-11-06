import { Suspense } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Loading } from '@/client/components/loading';
import { WorkspacePanelProvider } from '@/client/features/workspace';
import { PendingWorkspace } from './pending-workspace';
import { WorkspaceDetailContainer } from './workspace-detail-container';

export default function WorkspaceDetailPage() {
  const { id: workspaceId = '', slug = '' } = useParams<{ id: string; slug: string }>();
  const [searchParams] = useSearchParams();

  if (workspaceId.startsWith('optimistic-')) {
    return <PendingWorkspace id={workspaceId} slug={slug} />;
  }

  return (
    <WorkspacePanelProvider
      key={workspaceId}
      workspaceId={workspaceId}
      initialActiveTabId={searchParams.has('session') ? 'chat' : undefined}
    >
      <Suspense fallback={<Loading message="Loading chat…" />}>
        {/* Key by workspaceId to reset all state when switching workspaces.
            Without this, selectedDbSessionId would persist from the previous
            workspace and no session tab would be highlighted. */}
        <WorkspaceDetailContainer key={workspaceId} />
      </Suspense>
    </WorkspacePanelProvider>
  );
}
