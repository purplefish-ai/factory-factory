import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/client/lib/trpc';
import type { HostLoadSample } from './host-load';
import { hostLoadCursor, mergeHostLoadHistory } from './host-load-window';

/**
 * The window lives under its own key: tRPC's key for the procedure includes
 * the input, so a cursor that moves with every poll would start a new cache
 * entry each time.
 */
const HOST_LOAD_WINDOW_KEY = ['hostMetrics', 'window'] as const;

/**
 * The server's recent host load, oldest first. After the first poll each poll
 * asks only for the samples newer than the latest one held and merges them in,
 * so a steady poll carries about one sample instead of the whole window.
 */
export function useHostLoadSamples(refetchInterval: number) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: HOST_LOAD_WINDOW_KEY,
    queryFn: async ({ signal }) => {
      const held = queryClient.getQueryData<HostLoadSample[]>(HOST_LOAD_WINDOW_KEY);
      const history = await utils.client.admin.getHostMetrics.query(hostLoadCursor(held), {
        signal,
      });
      return mergeHostLoadHistory(held, history);
    },
    refetchInterval,
  });
}
