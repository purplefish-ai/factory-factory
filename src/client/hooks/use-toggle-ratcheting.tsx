import { useMutationState } from '@tanstack/react-query';
import { getMutationKey } from '@trpc/react-query';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import {
  type PRRecipientChoice,
  PRRecipientPicker,
} from '@/client/features/workspace/pr-recipient-picker';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { PRDeliveryMode } from '@/shared/pr-monitoring';
export interface ToggleRatchetingInput {
  workspaceId: string;
  enabled: boolean;
  resume?: boolean;
  deliveryMode?: PRDeliveryMode;
  recipientSessionId?: string | null;
  expectedBindingRevision?: number;
}
export interface UseToggleRatchetingReturn {
  mutate(input: ToggleRatchetingInput): void;
  mutateAsync(input: ToggleRatchetingInput): Promise<unknown>;
  isPending: boolean;
  /**
   * Workspaces with a toggle in flight from any caller, so each card or menu
   * shows its own pending state while other workspaces toggle independently.
   */
  pendingWorkspaceIds: readonly string[];
  recipientPicker: ReactNode;
}

function pendingWorkspaceId(variables: unknown): string | undefined {
  return typeof variables === 'object' &&
    variables !== null &&
    'workspaceId' in variables &&
    typeof variables.workspaceId === 'string'
    ? variables.workspaceId
    : undefined;
}
export function useToggleRatcheting(projectId?: string): UseToggleRatchetingReturn {
  const utils = trpc.useUtils();
  const [selection, setSelection] = useState<{
    workspaceId: string;
    bindingRevision: number;
    deliveryMode: PRDeliveryMode;
    resume?: boolean;
    candidates: PRRecipientChoice[];
  } | null>(null);
  const mutation = trpc.workspace.toggleRatcheting.useMutation({
    onSuccess: (result, input) => {
      if (
        result.status === 'recipient_required' &&
        input.enabled &&
        (input.deliveryMode ?? PRDeliveryMode.MAIN) === PRDeliveryMode.MAIN
      ) {
        setSelection({
          workspaceId: input.workspaceId,
          bindingRevision: result.bindingRevision,
          deliveryMode: input.deliveryMode ?? PRDeliveryMode.MAIN,
          candidates: result.candidates,
          resume: input.resume,
        });
      } else {
        setSelection(null);
      }
    },
    onError: (error) => {
      setSelection(null);
      toast.error(`Couldn't update PR monitoring. ${error.message}`);
    },
    onSettled: (_data, _error, input) => {
      runInBackground(
        utils.workspace.get.invalidate({ id: input.workspaceId }),
        "Couldn't refresh data."
      );
      if (projectId) {
        runInBackground(
          utils.workspace.listForProject.invalidate({ projectId }),
          "Couldn't refresh data."
        );
      }
    },
  });
  const pendingWorkspaceIds = useMutationState({
    filters: { mutationKey: getMutationKey(trpc.workspace.toggleRatcheting), status: 'pending' },
    select: (pending) => pendingWorkspaceId(pending.state.variables),
  }).filter((id) => id !== undefined);
  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    pendingWorkspaceIds,
    recipientPicker: selection ? (
      <PRRecipientPicker
        candidates={selection.candidates}
        pending={mutation.isPending}
        onCancel={() => setSelection(null)}
        onSelect={(recipientSessionId) =>
          mutation.mutate({
            workspaceId: selection.workspaceId,
            enabled: true,
            deliveryMode: selection.deliveryMode,
            ...(selection.resume === undefined ? {} : { resume: selection.resume }),
            recipientSessionId,
            expectedBindingRevision: selection.bindingRevision,
          })
        }
      />
    ) : null,
  };
}
