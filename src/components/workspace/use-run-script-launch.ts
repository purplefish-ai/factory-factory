import { trpc } from '@/frontend/lib/trpc';

interface RunScriptLaunchInfo {
  href: string;
  port: number;
  usesProxyUrl: boolean;
}

export function useRunScriptLaunch(workspaceId: string): RunScriptLaunchInfo | null {
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

  return {
    href: status.proxyUrl ?? `http://localhost:${status.port}`,
    port: status.port,
    usesProxyUrl: Boolean(status.proxyUrl),
  };
}
