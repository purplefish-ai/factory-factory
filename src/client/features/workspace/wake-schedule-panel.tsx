import { AlarmIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cadenceLabel } from '@/client/lib/cadence-labels';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface WakeSchedulePanelProps {
  workspaceId: string;
}

const OUTCOME_LABELS: Record<string, string> = {
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
  SKIPPED_NO_SESSION: 'Skipped — no session to wake',
};

export function WakeSchedulePanel({ workspaceId }: WakeSchedulePanelProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const utils = trpc.useUtils();
  const {
    data: schedule,
    isLoading,
    isError,
  } = trpc.workspaceWake.get.useQuery({ workspaceId }, { refetchInterval: 10_000 });
  const clearMutation = trpc.workspaceWake.clear.useMutation({
    onSuccess: () => {
      void utils.workspaceWake.get.invalidate({ workspaceId });
      void utils.workspace.get.invalidate({ id: workspaceId });
      setConfirmOpen(false);
    },
    onError: (error) => {
      toast.error(`Failed to cancel wake schedule: ${error.message}`);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-destructive">
        Failed to load wake schedule.
      </div>
    );
  }

  if (!schedule) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No wake schedule set for this workspace.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="px-3 py-2 border-b bg-muted/30 space-y-1">
        <div className="flex items-center gap-2">
          <AlarmIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-sm">Wake schedule</span>
          <Badge variant="secondary" className="text-[10px] shrink-0">
            {cadenceLabel(schedule.cadence)}
          </Badge>
          <Badge
            variant={schedule.enabled ? 'default' : 'secondary'}
            className="text-[10px] shrink-0"
          >
            {schedule.enabled ? 'Active' : 'Paused'}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {schedule.nextWakeAt && (
            <span>Next wake: {new Date(schedule.nextWakeAt).toLocaleString()}</span>
          )}
          {schedule.lastWakeAt && (
            <span>Last wake: {new Date(schedule.lastWakeAt).toLocaleString()}</span>
          )}
        </div>
      </div>

      <div className="px-3 py-2 space-y-3 text-xs">
        <div>
          <p className="text-[10px] uppercase text-muted-foreground mb-1">Prompt on wake</p>
          <p className="whitespace-pre-wrap">{schedule.prompt}</p>
        </div>

        {schedule.lastOutcome && (
          <div>
            <p className="text-[10px] uppercase text-muted-foreground mb-1">Last outcome</p>
            <p>{OUTCOME_LABELS[schedule.lastOutcome] ?? schedule.lastOutcome}</p>
            {schedule.lastError && <p className="text-destructive">{schedule.lastError}</p>}
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => setConfirmOpen(true)}
        >
          Cancel schedule
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Cancel wake schedule?"
        description="This workspace will no longer wake itself up. The schedule and its prompt will be removed."
        confirmText="Cancel schedule"
        variant="destructive"
        onConfirm={() => clearMutation.mutate({ workspaceId })}
        isPending={clearMutation.isPending}
      />
    </div>
  );
}
