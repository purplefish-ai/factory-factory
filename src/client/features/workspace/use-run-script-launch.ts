import { usePortSharing } from '@/client/hooks/use-port-sharing';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';

interface RunScriptLaunchInfo {
  href: string;
  port: number;
  usesProxyUrl: boolean;
}

export function useRunScriptLaunch(workspaceId: string): RunScriptLaunchInfo | null {
  const portSharing = usePortSharing();
  const { data: status } = trpc.workspace.getRunScriptStatus.useQuery(
    { workspaceId },
    {
      refetchInterval: (query) => {
        return query.state.data?.status === 'RUNNING'
          ? POLL_INTERVAL_MS.runningProcess
          : POLL_INTERVAL_MS.localStatus;
      },
    }
  );

  // Until port sharing is known, a fallback link could open the viewing
  // device's own localhost instead of the host's dev server.
  if (!status?.port || status.status !== 'RUNNING' || portSharing === undefined) {
    return null;
  }

  if (portSharing) {
    return { href: `/proxy/${status.port}/`, port: status.port, usesProxyUrl: true };
  }
  return {
    href: status.proxyUrl ?? `http://localhost:${status.port}`,
    port: status.port,
    usesProxyUrl: Boolean(status.proxyUrl),
  };
}
