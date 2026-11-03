import { lazy, type ReactNode, Suspense, useCallback, useSyncExternalStore } from 'react';
import { ImageDropZone } from '@/client/components/image-drop-zone';
import { ErrorBoundary } from '@/client/error-boundary';
import {
  getPendingWorkspaceCreationDropProjectIds,
  getWorkspaceCreationDropGeneration,
  stageWorkspaceCreationAttachments,
  subscribeWorkspaceCreationDrops,
} from './workspace-creation-drop-queue';

// The sidebar mounts this zone at startup. Dropped images wait in the
// dependency-free queue; draft storage and its launch option schemas load only
// once an image is actually dropped.
const WorkspaceCreationDropDrain = lazy(() =>
  import('./workspace-creation-drop-drain').then((module) => ({
    default: module.WorkspaceCreationDropDrain,
  }))
);

interface WorkspaceCreationImageDropZoneProps {
  projectId: string | undefined;
  disabled?: boolean;
  className?: string;
  onDropAccepted: () => void;
  children: ReactNode;
}

export function WorkspaceCreationImageDropZone({
  projectId,
  onDropAccepted,
  disabled,
  children,
  ...props
}: WorkspaceCreationImageDropZoneProps) {
  const generation = useSyncExternalStore(
    subscribeWorkspaceCreationDrops,
    useCallback(() => (projectId ? getWorkspaceCreationDropGeneration(projectId) : 0), [projectId])
  );
  const pendingProjectIds = useSyncExternalStore(
    subscribeWorkspaceCreationDrops,
    getPendingWorkspaceCreationDropProjectIds
  );
  return (
    <ImageDropZone
      {...props}
      disabled={!projectId || disabled}
      dropIdentity={`${projectId}/${generation}`}
      label="Drop images to attach to a new workspace"
      onDropAccepted={onDropAccepted}
      onAttachments={(attachments) => {
        if (projectId) {
          stageWorkspaceCreationAttachments(projectId, generation, attachments);
        }
      }}
    >
      {children}
      {pendingProjectIds.length > 0 && (
        // A null fallback would render the boundary's full-page error; the form
        // reports chunk failures, so the drain stays invisible.
        <ErrorBoundary fallback={<span hidden />}>
          <Suspense fallback={null}>
            {pendingProjectIds.map((pendingProjectId) => (
              <WorkspaceCreationDropDrain key={pendingProjectId} projectId={pendingProjectId} />
            ))}
          </Suspense>
        </ErrorBoundary>
      )}
    </ImageDropZone>
  );
}
