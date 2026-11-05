import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { isWorkspaceDoneOrMerged } from '@/client/lib/workspace-archive';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
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
      disabled={archivePending}
      className={cn(
        completed ? '' : 'text-destructive focus:text-destructive dark:text-destructive'
      )}
    >
      {archivePending ? (
        <Spinner aria-hidden="true" className="h-4 w-4" />
      ) : (
        <ArchiveIcon className="h-4 w-4" />
      )}
      {archivePending ? 'Archiving…' : 'Archive workspace'}
    </DropdownMenuItem>
  );
}
