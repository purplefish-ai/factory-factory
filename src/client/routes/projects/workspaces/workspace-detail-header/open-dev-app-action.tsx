import { Server } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useRunScriptLaunch } from '@/components/workspace';

export function OpenDevAppAction({
  workspaceId,
  renderAsMenuItem = false,
}: {
  workspaceId: string;
  renderAsMenuItem?: boolean;
}) {
  const launchInfo = useRunScriptLaunch(workspaceId);
  if (!launchInfo) {
    return null;
  }

  if (renderAsMenuItem) {
    return (
      <DropdownMenuItem asChild>
        <a href={launchInfo.href} target="_blank" rel="noopener noreferrer">
          <Server className="h-4 w-4" />
          Open dev app
        </a>
      </DropdownMenuItem>
    );
  }

  return null;
}
