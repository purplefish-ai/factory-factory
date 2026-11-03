import { isLoopbackHostname } from '@/client/lib/loopback-links';
import { trpc } from '@/client/lib/trpc';

/**
 * Whether loopback links should open through `/proxy/<port>`: the server runs
 * under `ff tailscale` and this page is not itself on the host's loopback.
 */
export function usePortSharing(): boolean {
  const { data } = trpc.portShare.getStatus.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  return (
    data?.available === true &&
    typeof window !== 'undefined' &&
    !isLoopbackHostname(window.location.hostname)
  );
}
