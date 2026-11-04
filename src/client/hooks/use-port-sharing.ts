import { isLoopbackHostname } from '@/client/lib/loopback-links';
import { trpc } from '@/client/lib/trpc';

/**
 * Whether loopback links should open through `/proxy/<port>`: the server runs
 * under `ff tailscale` and this page is not itself on the host's loopback.
 * `undefined` while the server's answer is loading or has failed, so callers never offer a
 * link that would point at the viewing device's own localhost.
 */
export function usePortSharing(): boolean | undefined {
  const remotePage = typeof window !== 'undefined' && !isLoopbackHostname(window.location.hostname);
  const { data, isError } = trpc.portShare.getStatus.useQuery(undefined, {
    enabled: remotePage,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  if (!remotePage) {
    return false;
  }
  return isError ? undefined : data?.available;
}
