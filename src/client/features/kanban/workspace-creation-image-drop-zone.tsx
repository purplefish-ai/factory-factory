import {
  Component,
  type ErrorInfo,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useSyncExternalStore,
} from 'react';
import { toast } from 'sonner';
import { ImageDropZone } from '@/client/components/image-drop-zone';
import { reportBoundaryError } from '@/client/error-boundary';
import {
  getPendingWorkspaceCreationDropProjectIds,
  getWorkspaceCreationDropGeneration,
  stageWorkspaceCreationAttachments,
  subscribeWorkspaceCreationDrops,
  takeWorkspaceCreationAttachments,
} from './workspace-creation-drop-queue';

// The sidebar mounts this zone at startup. Dropped images wait in the
// dependency-free queue; draft storage and its launch option schemas load only
// once an image is actually dropped.
function lazyDropDrain() {
  return lazy(() =>
    import('./workspace-creation-drop-drain').then((module) => ({
      default: module.WorkspaceCreationDropDrain,
    }))
  );
}
let WorkspaceCreationDropDrain = lazyDropDrain();

/** Reports a failed drain load and lets the next drop retry with a fresh import. */
class DropDrainBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // React.lazy caches a rejected import for the lifetime of the component.
    WorkspaceCreationDropDrain = lazyDropDrain();
    // Discarding the queue unmounts this boundary, so the next drop starts clean.
    for (const projectId of getPendingWorkspaceCreationDropProjectIds()) {
      takeWorkspaceCreationAttachments(projectId);
    }
    toast.error('Dropped images could not be attached. Try dropping them again.');
    reportBoundaryError(error, errorInfo);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

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
        <DropDrainBoundary>
          <Suspense fallback={null}>
            {pendingProjectIds.map((pendingProjectId) => (
              <WorkspaceCreationDropDrain key={pendingProjectId} projectId={pendingProjectId} />
            ))}
          </Suspense>
        </DropDrainBoundary>
      )}
    </ImageDropZone>
  );
}
