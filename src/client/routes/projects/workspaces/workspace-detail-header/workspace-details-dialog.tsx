import { SectionLabel } from '@/client/components/section-label';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { WorkspaceHeaderWorkspace } from './types';

/** The workspace's description and initial prompt, opened from "View details". */
export function WorkspaceDetailsDialog({
  open,
  onOpenChange,
  workspace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Pick<WorkspaceHeaderWorkspace, 'description' | 'initialPrompt'>;
}) {
  const description = workspace.description?.trim();
  const initialPrompt = workspace.initialPrompt?.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Workspace details</DialogTitle>
        </DialogHeader>
        {description || initialPrompt ? (
          <div className="flex flex-col gap-4">
            {description && <DetailSection label="Description" text={description} />}
            {initialPrompt && <DetailSection label="Initial prompt" text={initialPrompt} />}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No description or initial prompt was provided for this workspace.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailSection({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>{label}</SectionLabel>
      <p className="text-sm whitespace-pre-wrap break-words">{text}</p>
    </div>
  );
}
