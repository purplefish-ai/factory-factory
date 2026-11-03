import { usePortSharing } from '@/client/hooks/use-port-sharing';
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
        return query.state.data?.status === 'RUNNING' ? 2000 : 5000;
      },
    }
  );

  if (!status?.port || status.status !== 'RUNNING') {
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
