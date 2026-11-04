import { getStatusToneStyle } from '@/client/lib/status-tones';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { WorkspaceStatusReason } from '@/shared/workspace-status-reason';

function getKanbanStatusLabel(statusReason: WorkspaceStatusReason): string {
  return statusReason.code === 'WAITING_FOR_CI' ? 'CI Running' : statusReason.label;
}

export function KanbanStatusChip({ statusReason }: { statusReason: WorkspaceStatusReason }) {
  return (
    <Badge
      variant="outline"
      data-testid="kanban-status-chip"
      data-status-tone={statusReason.tone}
      className={cn(
        'w-fit px-1.5 py-0.5 text-[10px] font-medium tracking-wide',
        getStatusToneStyle(statusReason.tone).chip
      )}
    >
      {getKanbanStatusLabel(statusReason)}
    </Badge>
  );
}
