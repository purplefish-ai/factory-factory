import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import {
  type PRRecipientChoice,
  PRRecipientPicker,
} from '@/client/features/workspace/pr-recipient-picker';
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
  recipientPicker: ReactNode;
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
      toast.error(`Failed to update PR monitoring: ${error.message}`);
    },
    onSettled: (_data, _error, input) => {
      utils.workspace.get.invalidate({ id: input.workspaceId });
      if (projectId) {
        utils.workspace.listForProject.invalidate({ projectId });
      }
    },
  });
  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
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
