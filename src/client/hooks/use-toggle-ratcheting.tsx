import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { type PRRecipientChoice, PRRecipientPicker } from '@/client/features/workspace';
import { trpc } from '@/client/lib/trpc';
export interface ToggleRatchetingInput {
  workspaceId: string;
  enabled: boolean;
  recipientSessionId?: string | null;
  expectedBindingRevision?: number;
}
export interface UseToggleRatchetingReturn {
  mutate(input: ToggleRatchetingInput): void;
  mutateAsync(input: ToggleRatchetingInput): Promise<unknown>;
  isPending: boolean;
  recipientPicker: ReactNode;
}
export function useToggleRatcheting(projectId: string): UseToggleRatchetingReturn {
  const utils = trpc.useUtils();
  const [selection, setSelection] = useState<{
    workspaceId: string;
    bindingRevision: number;
    candidates: PRRecipientChoice[];
  } | null>(null);
  const mutation = trpc.workspace.toggleRatcheting.useMutation({
    onSuccess: (result, input) => {
      if (result.status === 'recipient_required') {
        setSelection({
          workspaceId: input.workspaceId,
          bindingRevision: result.bindingRevision,
          candidates: result.candidates,
        });
      } else {
        setSelection(null);
      }
    },
    onError: (error) => toast.error(`Failed to update PR monitoring: ${error.message}`),
    onSettled: (_data, _error, input) => {
      utils.workspace.get.invalidate({ id: input.workspaceId });
      utils.workspace.listForProject.invalidate({ projectId });
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
            recipientSessionId,
            expectedBindingRevision: selection.bindingRevision,
          })
        }
      />
    ) : null,
  };
}
