import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { WorkspaceHeaderWorkspace } from './types';

export function ArchiveActionButton({
  workspace,
  archivePending,
  onArchiveRequest,
}: {
  workspace: WorkspaceHeaderWorkspace;
  archivePending: boolean;
  onArchiveRequest: () => void;
}) {
  const completed = isWorkspaceDoneOrMerged(workspace);

  return (
    <DropdownMenuItem
      onSelect={onArchiveRequest}
      pending={archivePending}
      className={cn(
        completed ? '' : 'text-destructive focus:text-destructive dark:text-destructive'
      )}
    >
      <ArchiveIcon className="h-4 w-4" />
      {archivePending ? 'Archiving…' : 'Archive workspace'}
    </DropdownMenuItem>
  );
}
