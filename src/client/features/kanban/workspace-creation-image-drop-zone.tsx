import type { ReactNode } from 'react';
import { ImageDropZone } from '@/client/features/composer';
import { cn } from '@/lib/utils';
import { useWorkspaceCreationDraft } from './use-workspace-creation-draft';

interface WorkspaceCreationImageDropZoneProps {
  projectId: string | undefined;
  disabled?: boolean;
  className?: string;
  onDropAccepted: () => void;
  children: ReactNode;
}

function ProjectImageDropZone({
  projectId,
  onDropAccepted,
  ...props
}: WorkspaceCreationImageDropZoneProps & { projectId: string }) {
  const { updateDraft, generation } = useWorkspaceCreationDraft(projectId);
  return (
    <ImageDropZone
      {...props}
      dropIdentity={`${projectId}/${generation}`}
      label="Drop images to attach to a new workspace"
      onDropAccepted={onDropAccepted}
      onAttachments={(attachments) =>
        updateDraft((draft) => ({ attachments: [...draft.attachments, ...attachments] }))
      }
    />
  );
}

/** Shared creation destination for the board and navigation sidebar. */
export function WorkspaceCreationImageDropZone(props: WorkspaceCreationImageDropZoneProps) {
  if (!props.projectId) {
    return <div className={cn('relative h-full min-h-0', props.className)}>{props.children}</div>;
  }
  return <ProjectImageDropZone {...props} projectId={props.projectId} />;
}
