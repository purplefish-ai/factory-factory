import { useMutation } from '@tanstack/react-query';
import { useCallback } from 'react';
import { trpc } from '@/client/lib/trpc';

/**
 * Forces a fresh CLI health check and publishes it to the cached
 * `checkCLIHealth` query. A mutation, so `isRefreshing` is its `isPending`
 * and a failure reports through the app's mutation error toast.
 */
export function useCLIHealthRefresh() {
  const utils = trpc.useUtils();
  const { mutate, isPending } = useMutation({
    mutationFn: () => utils.admin.checkCLIHealth.fetch({ forceRefresh: true }, { staleTime: 0 }),
    onSuccess: (health) => {
      utils.admin.checkCLIHealth.setData({ forceRefresh: false }, health);
    },
    meta: { errorToast: "Couldn't refresh CLI authentication status. Try Recheck again." },
  });
  const refresh = useCallback(() => mutate(), [mutate]);
  return { refresh, isRefreshing: isPending };
}
