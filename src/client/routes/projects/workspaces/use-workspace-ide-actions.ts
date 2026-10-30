import { useMemo } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';

interface IdeActions {
  openInIde: {
    mutate: (input: { id: string }) => void;
    isPending: boolean;
  };
  availableIdes: { id: string; name: string }[];
  preferredIde: string;
}

const NO_IDES: IdeActions['availableIdes'] = [];

export function useWorkspaceIdeActions(): IdeActions {
  const { mutate, isPending } = trpc.workspace.openInIde.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const { data } = trpc.workspace.getAvailableIdes.useQuery();
  // The mutation result object is new on every render; expose a stable view so
  // memoized header actions only re-render when the pending state changes.
  const openInIde = useMemo(() => ({ mutate, isPending }), [mutate, isPending]);
  return {
    openInIde,
    availableIdes: data?.ides ?? NO_IDES,
    preferredIde: data?.preferredIde ?? 'cursor',
  };
}
