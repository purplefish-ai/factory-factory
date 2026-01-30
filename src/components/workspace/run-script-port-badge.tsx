import { Server } from 'lucide-react';
import { trpc } from '@/frontend/lib/trpc';

interface RunScriptPortBadgeProps {
  workspaceId: string;
}

export function RunScriptPortBadge({ workspaceId }: RunScriptPortBadgeProps) {
  // Query run script status
  const { data: status } = trpc.workspace.getRunScriptStatus.useQuery(
    { workspaceId },
    {
      refetchInterval: (query) => {
        // Poll more frequently when running
        return query.state.data?.status === 'RUNNING' ? 2000 : 5000;
      },
    }
  );

  // Only show badge when script is running and has a port
  if (!status?.port || status.status !== 'RUNNING') {
    return null;
  }

  return (
    <a
      href={`http://localhost:${status.port}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/15 text-green-700 dark:text-green-400 hover:bg-green-500/25 transition-colors text-sm font-medium"
      title={`Dev server running on port ${status.port}`}
    >
      <Server className="h-4 w-4" />
      <span>:{status.port}</span>
    </a>
  );
}
