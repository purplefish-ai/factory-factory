import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ToolSequenceGroup } from '@/components/agent-activity/tool-renderers';
import { Badge } from '@/components/ui/badge';
import type { ToolSequence } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { AcpPlanView } from './acp-plan-view';
import { LatestThinking } from './latest-thinking';
import type { AcpPlanState, ToolProgressInfo } from './reducer/types';

interface AgentLiveDockProps {
  workspaceId: string;
  running: boolean;
  starting: boolean;
  stopping: boolean;
  permissionMode: string | null;
  latestThinking: string | null;
  latestToolSequence: ToolSequence | null;
  /** ACP agent plan state for structured task list rendering */
  acpPlan?: AcpPlanState | null;
  /** Tool progress map for ACP location rendering */
  toolProgress?: Map<string, ToolProgressInfo>;
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
  acpPlan,
  toolProgress,
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

  const hasAcpPlan = acpPlan != null && acpPlan.entries.length > 0;
  const hasThinking = latestThinking !== null && (running || stopping || Boolean(permissionMode));
  const hasContent = hasThinking || Boolean(mostRecentToolSequence) || hasAcpPlan;
  const { label, tone } = getPhaseLabel({ running, starting, stopping, permissionMode });

  if (!(hasContent || running || starting || stopping || permissionMode)) {
    return null;
  }

  // Calculate max height for tool details based on available space
  // Container overhead: py-3 (24px) + Header (~32px) + mt-3 (12px) + tool trigger button (~28px)
  // When thinking is present: thinking section (~60px) + space-y-3 gap (12px)
  // The maxHeight is applied to CollapsibleContent which includes labels/padding internally
  const baseOverhead = 84; // py-3 (24px) + header (~24px) + mt-3 (12px) + trigger (~24px)
  const thinkingReserve = hasThinking ? 72 : 0; // thinking height (~60px) + space-y-3 gap (12px)
  const toolDetailsMaxHeight = Math.max(60, height - baseOverhead - thinkingReserve);

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
                toolDetailsClassName="overflow-y-auto"
                toolDetailsMaxHeight={toolDetailsMaxHeight}
              />
              {/* ACP tool progress locations */}
              {toolProgress && toolProgress.size > 0 && (
                <div className="mt-1 space-y-0.5">
                  {[...toolProgress.entries()].map(([toolUseId, progress]) =>
                    progress.acpLocations && progress.acpLocations.length > 0 ? (
                      <div key={`tp-${toolUseId}`} className="flex flex-wrap gap-1">
                        {progress.acpLocations.map((loc, i) => (
                          <button
                            key={`${loc.path}-${loc.line ?? ''}-${i}`}
                            type="button"
                            className="text-[10px] text-blue-500 hover:text-blue-600 hover:underline font-mono truncate max-w-[200px]"
                            title={loc.line ? `${loc.path}:${loc.line}` : loc.path}
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent('acp-open-file', {
                                  detail: { path: loc.path, line: loc.line },
                                })
                              );
                            }}
                          >
                            {loc.path.split('/').pop()}
                            {loc.line ? `:${loc.line}` : ''}
                          </button>
                        ))}
                      </div>
                    ) : null
                  )}
                </div>
              )}
            </div>
          )}

          {hasAcpPlan && acpPlan && (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-muted-foreground">Agent plan</div>
              <AcpPlanView entries={acpPlan.entries} />
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
