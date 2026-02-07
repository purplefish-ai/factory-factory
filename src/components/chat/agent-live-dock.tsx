import { memo, useCallback, useEffect, useRef, useState } from 'react';
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
const HEIGHT_KEY_PREFIX = 'agent-live-dock-height-';
const DEFAULT_HEIGHT = 176; // Default height in pixels (matches h-44)
const MIN_HEIGHT = 100; // Minimum height in pixels
const MAX_HEIGHT = 600; // Maximum height in pixels

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

function readHeight(workspaceId: string): number | null {
  try {
    const stored = window.localStorage.getItem(`${HEIGHT_KEY_PREFIX}${workspaceId}`);
    if (stored === null) {
      return null;
    }
    const parsed = Number.parseInt(stored, 10);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, parsed));
  } catch {
    return null;
  }
}

function saveHeight(workspaceId: string, height: number): void {
  try {
    window.localStorage.setItem(`${HEIGHT_KEY_PREFIX}${workspaceId}`, String(height));
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
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  useEffect(() => {
    skipNextPersistRef.current = true;
    setIsDragging(false);
    const storedOpen = readToolWindowOpen(workspaceId);
    setToolWindowOpen(storedOpen ?? true);
    const storedHeight = readHeight(workspaceId);
    setHeight(storedHeight ?? DEFAULT_HEIGHT);
  }, [workspaceId]);

  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    saveToolWindowOpen(workspaceId, toolWindowOpen);
  }, [workspaceId, toolWindowOpen]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startYRef.current = e.clientY;
      startHeightRef.current = height;
    },
    [height]
  );

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = startYRef.current - e.clientY;
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeightRef.current + deltaY));
      setHeight(newHeight);
    };

    const handleMouseUp = (e: MouseEvent) => {
      setIsDragging(false);
      // Calculate the final height directly to avoid stale closure
      const deltaY = startYRef.current - e.clientY;
      const finalHeight = Math.max(
        MIN_HEIGHT,
        Math.min(MAX_HEIGHT, startHeightRef.current + deltaY)
      );
      saveHeight(workspaceId, finalHeight);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, workspaceId]);

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
    <div className={cn('bg-muted/20 border-b relative', className)}>
      <div className="px-4 py-3 flex flex-col" style={{ height: `${height}px` }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Live activity</span>
          <Badge variant={tone} className="text-[10px] px-1.5 py-0">
            {label}
          </Badge>
        </div>

        <div className="mt-3 min-h-0 space-y-3 overflow-y-auto">
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

      {/* Resize handle */}
      <button
        type="button"
        className={cn(
          'absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-primary/20 transition-colors border-0 p-0',
          isDragging && 'bg-primary/30'
        )}
        onMouseDown={handleMouseDown}
        aria-label="Drag to resize activity feed"
      />
    </div>
  );
});
