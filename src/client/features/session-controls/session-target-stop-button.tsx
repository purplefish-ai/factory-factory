import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { SquareIcon } from '@phosphor-icons/react/dist/csr/Square';
import { useSyncExternalStore } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { SessionStopTarget } from '@/shared/acp-protocol/subagents';
import {
  subscribePendingStops,
  isSessionTargetStopPending,
  requestSessionTargetStop,
} from './session-target-stop-state';

/** Mount only for a current live capability; its withdrawal owns completion. */
export function SessionTargetStopButton({
  sessionId,
  target,
  itemLabel,
}: {
  sessionId: string;
  target: SessionStopTarget;
  itemLabel: string;
}) {
  const mutation = trpc.session.stopTarget.useMutation();
  const pending = useSyncExternalStore(
    subscribePendingStops,
    () => isSessionTargetStopPending(sessionId, target),
    () => false
  );
  const label = target.kind === 'task' ? 'Stop process' : 'Stop subagent';
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-label={`${label}: ${itemLabel}`}
            disabled={pending}
            onClick={() => {
              void requestSessionTargetStop(sessionId, target, () =>
                mutation.mutateAsync({ sessionId, target })
              );
            }}
          >
            {pending ? (
              <SpinnerGapIcon className="h-4 w-4 motion-safe:animate-spin" />
            ) : (
              <SquareIcon className="h-3 w-3" weight="fill" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
