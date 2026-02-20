import { Server } from 'lucide-react';
import { useRunScriptLaunch } from './use-run-script-launch';

interface RunScriptPortBadgeProps {
  workspaceId: string;
}

export function RunScriptPortBadge({ workspaceId }: RunScriptPortBadgeProps) {
  const launchInfo = useRunScriptLaunch(workspaceId);
  if (!launchInfo) {
    return null;
  }

  return (
    <a
      href={launchInfo.href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/15 text-green-700 dark:text-green-400 hover:bg-green-500/25 transition-colors text-sm font-medium"
      title={
        launchInfo.usesProxyUrl
          ? `Dev server tunnel on port ${launchInfo.port}`
          : `Dev server running on port ${launchInfo.port}`
      }
    >
      <Server className="h-4 w-4" />
      <span>:{launchInfo.port}</span>
    </a>
  );
}
