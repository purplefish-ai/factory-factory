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

export function useWorkspaceIdeActions(): IdeActions {
  const openInIde = trpc.workspace.openInIde.useMutation({
    onError: (error) => toast.error(error.message),
  });
  const { data } = trpc.workspace.getAvailableIdes.useQuery();
  return {
    openInIde,
    availableIdes: data?.ides ?? [],
    preferredIde: data?.preferredIde ?? 'cursor',
  };
}
