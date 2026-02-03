import { Suspense } from 'react';
import { useParams } from 'react-router';

import { WorkspacePanelProvider } from '@/components/workspace';

import { WorkspaceDetailContainer } from './workspace-detail-container';
import { ChatLoading } from './workspace-detail-loading';

export default function WorkspaceDetailPage() {
  const { id: workspaceId = '' } = useParams<{ id: string }>();

  return (
    <WorkspacePanelProvider workspaceId={workspaceId}>
      <Suspense fallback={<ChatLoading />}>
        {/* Key by workspaceId to reset all state when switching workspaces.
            Without this, selectedDbSessionId would persist from the previous
            workspace and no session tab would be highlighted. */}
        <WorkspaceDetailContainer key={workspaceId} />
      </Suspense>
    </WorkspacePanelProvider>
  );
}
