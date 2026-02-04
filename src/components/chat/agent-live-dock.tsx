import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { ToolSequence } from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import { ToolSequenceGroup } from '../agent-activity/tool-renderers';
import { LatestThinking } from './latest-thinking';

interface AgentLiveDockProps {
  running: boolean;
  starting: boolean;
  stopping: boolean;
  permissionMode: string | null;
  latestThinking: string | null;
  latestToolSequence: ToolSequence | null;
  className?: string;
}

function getPhaseLabel({
  running,
  starting,
  stopping,
  permissionMode,
}: Pick<AgentLiveDockProps, 'running' | 'starting' | 'stopping' | 'permissionMode'>): {
  label: string;
  tone: 'default' | 'outline';
} {
  if (starting) {
    return { label: 'Starting', tone: 'outline' };
  }
  if (stopping) {
    return { label: 'Stopping', tone: 'outline' };
  }
  if (permissionMode) {
    return { label: `Waiting (${permissionMode})`, tone: 'outline' };
  }
  if (running) {
    return { label: 'Running', tone: 'default' };
  }
  return { label: 'Idle', tone: 'outline' };
}

export const AgentLiveDock = memo(function AgentLiveDock({
  running,
  starting,
  stopping,
  permissionMode,
  latestThinking,
  latestToolSequence,
  className,
}: AgentLiveDockProps) {
  const hasThinking = Boolean(latestThinking) && running;
  const hasContent = hasThinking || Boolean(latestToolSequence);
  const { label, tone } = getPhaseLabel({ running, starting, stopping, permissionMode });

  if (!(hasContent || running || starting || stopping || permissionMode)) {
    return null;
  }

  return (
    <div className={cn('bg-muted/20 border-b', className)}>
      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Live activity</span>
          <Badge variant={tone} className="text-[10px] px-1.5 py-0">
            {label}
          </Badge>
        </div>

        {latestToolSequence && (
          <div className="space-y-1">
            <div className="text-[10px] font-medium text-muted-foreground">Latest tool</div>
            <ToolSequenceGroup
              sequence={latestToolSequence}
              defaultOpen
              summaryOrder="latest-first"
            />
          </div>
        )}

        {latestThinking && running && (
          <div className="space-y-1">
            <div className="text-[10px] font-medium text-muted-foreground">Latest thinking</div>
            <LatestThinking thinking={latestThinking} running={running} />
          </div>
        )}
      </div>
    </div>
  );
});
