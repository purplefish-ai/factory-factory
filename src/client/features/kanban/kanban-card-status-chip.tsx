import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type {
  WorkspaceStatusReason,
  WorkspaceStatusReasonTone,
} from '@/shared/workspace-status-reason';

const TONE_CLASSES: Record<WorkspaceStatusReasonTone, string> = {
  neutral: 'border-transparent bg-muted text-muted-foreground',
  working: 'border-transparent bg-brand/15 text-brand',
  waiting: 'border-transparent bg-yellow-500/15 text-yellow-700 dark:text-yellow-300',
  attention: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300',
  success: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  danger: 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
};

function getKanbanStatusLabel(statusReason: WorkspaceStatusReason): string {
  return statusReason.code === 'WAITING_FOR_CI' ? 'CI Running' : statusReason.label;
}

export function KanbanStatusChip({ statusReason }: { statusReason: WorkspaceStatusReason }) {
  return (
    <Badge
      variant="outline"
      data-testid="kanban-status-chip"
      className={cn(
        'w-fit px-1.5 py-0.5 text-[10px] font-medium tracking-wide',
        TONE_CLASSES[statusReason.tone]
      )}
    >
      {getKanbanStatusLabel(statusReason)}
    </Badge>
  );
}
