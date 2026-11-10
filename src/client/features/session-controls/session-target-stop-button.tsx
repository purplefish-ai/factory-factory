import { SquareIcon } from '@phosphor-icons/react/dist/csr/Square';
import { useSyncExternalStore } from 'react';
import { IconButton } from '@/client/components/icon-button';
import { trpc } from '@/client/lib/trpc';
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
  const mutation = trpc.session.stopTarget.useMutation({ meta: { errorToast: false } });
  const pending = useSyncExternalStore(
    subscribePendingStops,
    () => isSessionTargetStopPending(sessionId, target),
    () => false
  );
  const label = target.kind === 'task' ? 'Stop process' : 'Stop subagent';
  return (
    <IconButton
      type="button"
      size="icon-compact"
      className="shrink-0 text-muted-foreground"
      label={`${label}: ${itemLabel}`}
      tooltip={label}
      pending={pending}
      onClick={() => {
        void requestSessionTargetStop(sessionId, target, () =>
          mutation.mutateAsync({ sessionId, target })
        );
      }}
    >
      <SquareIcon weight="fill" />
    </IconButton>
  );
}
