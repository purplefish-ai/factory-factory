import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
const DOCK_EXPANDED_KEY_PREFIX = 'agent-live-dock-expanded-';

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

function readDockExpanded(workspaceId: string): boolean | null {
  try {
    const stored = window.localStorage.getItem(`${DOCK_EXPANDED_KEY_PREFIX}${workspaceId}`);
    if (stored === null) {
      return null;
    }
    return stored === 'true';
  } catch {
    return null;
  }
}

function saveDockExpanded(workspaceId: string, expanded: boolean): void {
  try {
    window.localStorage.setItem(`${DOCK_EXPANDED_KEY_PREFIX}${workspaceId}`, String(expanded));
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
  const skipNextToolPersistRef = useRef(false);
  const skipNextDockPersistRef = useRef(false);
  const [toolWindowOpen, setToolWindowOpen] = useState(true);
  const [dockExpanded, setDockExpanded] = useState(true);

  useEffect(() => {
    skipNextToolPersistRef.current = true;
    const storedOpen = readToolWindowOpen(workspaceId);
    setToolWindowOpen(storedOpen ?? true);
  }, [workspaceId]);

  useEffect(() => {
    if (skipNextToolPersistRef.current) {
      skipNextToolPersistRef.current = false;
      return;
    }
    saveToolWindowOpen(workspaceId, toolWindowOpen);
  }, [workspaceId, toolWindowOpen]);

  useEffect(() => {
    skipNextDockPersistRef.current = true;
    const storedExpanded = readDockExpanded(workspaceId);
    setDockExpanded(storedExpanded ?? true);
  }, [workspaceId]);

  useEffect(() => {
    if (skipNextDockPersistRef.current) {
      skipNextDockPersistRef.current = false;
      return;
    }
    saveDockExpanded(workspaceId, dockExpanded);
  }, [workspaceId, dockExpanded]);

  const hasThinking = latestThinking !== null && (running || stopping || Boolean(permissionMode));
  const hasContent = hasThinking || Boolean(latestToolSequence);
  const { label, tone } = getPhaseLabel({ running, starting, stopping, permissionMode });

  if (!(hasContent || running || starting || stopping || permissionMode)) {
    return null;
  }

  return (
    <div className={cn('bg-muted/20 border-b', className)}>
      <div className="px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 hover:bg-muted/50"
            onClick={() => setDockExpanded(!dockExpanded)}
          >
            {dockExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </Button>
          <span className="text-xs font-medium text-muted-foreground">Live activity</span>
          <Badge variant={tone} className="text-[10px] px-1.5 py-0">
            {label}
          </Badge>
        </div>

        {dockExpanded && latestToolSequence && (
          <div>
            <ToolSequenceGroup
              sequence={latestToolSequence}
              summaryOrder="latest-first"
              open={toolWindowOpen}
              onOpenChange={setToolWindowOpen}
            />
          </div>
        )}

        {dockExpanded && hasThinking && (
          <div className="space-y-1">
            <div className="text-[10px] font-medium text-muted-foreground">Latest thinking</div>
            <LatestThinking thinking={latestThinking} running={running || starting} />
          </div>
        )}
      </div>
    </div>
  );
});
