import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';

export function useCLIHealthRefresh() {
  const utils = trpc.useUtils();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      const health = await utils.admin.checkCLIHealth.fetch(
        { forceRefresh: true },
        { staleTime: 0 }
      );
      utils.admin.checkCLIHealth.setData({ forceRefresh: false }, health);
    } catch {
      toast.error('Failed to refresh CLI authentication status. Try Recheck again.');
    } finally {
      setIsRefreshing(false);
    }
  };

  return { refresh, isRefreshing };
}
