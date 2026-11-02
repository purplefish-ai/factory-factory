import type { ReactNode } from 'react';
import { ImageDropZone } from '@/client/features/composer';
import { useWorkspaceCreationDraft } from './use-workspace-creation-draft';

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
  ...props
}: WorkspaceCreationImageDropZoneProps) {
  const { updateDraft, generation } = useWorkspaceCreationDraft(
    projectId ?? '',
    Boolean(projectId)
  );
  return (
    <ImageDropZone
      {...props}
      disabled={!projectId || disabled}
      dropIdentity={`${projectId}/${generation}`}
      label="Drop images to attach to a new workspace"
      onDropAccepted={onDropAccepted}
      onAttachments={(attachments) =>
        updateDraft((draft) => ({ attachments: [...draft.attachments, ...attachments] }))
      }
    />
  );
}
