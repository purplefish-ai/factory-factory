import { StatusChip } from '@/client/components/status-indicators';
import type { WorkspaceStatusReason } from '@/shared/workspace-status-reason';

function getKanbanStatusLabel(statusReason: WorkspaceStatusReason): string {
  return statusReason.code === 'WAITING_FOR_CI' ? 'CI Running' : statusReason.label;
}

export function KanbanStatusChip({ statusReason }: { statusReason: WorkspaceStatusReason }) {
  return (
    <StatusChip tone={statusReason.tone} data-testid="kanban-status-chip">
      {getKanbanStatusLabel(statusReason)}
    </StatusChip>
  );
}
