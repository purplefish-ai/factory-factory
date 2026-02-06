import { memo, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import type { ToolSequence } from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import { ToolSequenceGroup } from '../agent-activity/tool-renderers';
import { LatestThinking } from './latest-thinking';

interface AgentLiveDockProps {
  workspaceId: string;
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

const TOOL_WINDOW_OPEN_KEY_PREFIX = 'agent-live-dock-tool-open-';

function readToolWindowOpen(workspaceId: string): boolean | null {
  try {
    const stored = window.localStorage.getItem(`${TOOL_WINDOW_OPEN_KEY_PREFIX}${workspaceId}`);
    if (stored === null) {
      return null;
    }
    return stored === 'true';
  } catch {
    return null;
  }
}

function saveToolWindowOpen(workspaceId: string, open: boolean): void {
  try {
    window.localStorage.setItem(`${TOOL_WINDOW_OPEN_KEY_PREFIX}${workspaceId}`, String(open));
  } catch {
    // Ignore localStorage failures.
  }
}

export const AgentLiveDock = memo(function AgentLiveDock({
  workspaceId,
  running,
  starting,
  stopping,
  permissionMode,
  latestThinking,
  latestToolSequence,
  className,
}: AgentLiveDockProps) {
  const skipNextPersistRef = useRef(false);
  const [toolWindowOpen, setToolWindowOpen] = useState(true);

  useEffect(() => {
    skipNextPersistRef.current = true;
    const storedOpen = readToolWindowOpen(workspaceId);
    setToolWindowOpen(storedOpen ?? true);
  }, [workspaceId]);

  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    saveToolWindowOpen(workspaceId, toolWindowOpen);
  }, [workspaceId, toolWindowOpen]);

  // Get only the most recent tool call from the sequence
  const mostRecentToolCall =
    latestToolSequence?.pairedCalls[latestToolSequence.pairedCalls.length - 1];
  const mostRecentToolSequence = mostRecentToolCall
    ? {
        ...latestToolSequence,
        pairedCalls: [mostRecentToolCall],
      }
    : null;

  const hasThinking = latestThinking !== null && (running || stopping || Boolean(permissionMode));
  const hasContent = hasThinking || Boolean(mostRecentToolSequence);
  const { label, tone } = getPhaseLabel({ running, starting, stopping, permissionMode });

  if (!(hasContent || running || starting || stopping || permissionMode)) {
    return null;
  }

  return (
    <div className={cn('bg-muted/20 border-b', className)}>
      <div className="h-36 sm:h-44 px-4 py-3 flex flex-col">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Live activity</span>
          <Badge variant={tone} className="text-[10px] px-1.5 py-0">
            {label}
          </Badge>
        </div>

        <div className="mt-3 min-h-0 space-y-3 overflow-hidden">
          {mostRecentToolSequence && (
            <div>
              <ToolSequenceGroup
                sequence={mostRecentToolSequence}
                summaryOrder="latest-first"
                open={toolWindowOpen}
                onOpenChange={setToolWindowOpen}
                toolDetailsClassName="max-h-24 overflow-y-auto"
              />
            </div>
          )}

          {hasThinking && (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-muted-foreground">Latest thinking</div>
              <LatestThinking thinking={latestThinking} running={running || starting} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
