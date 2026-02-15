import { AlertTriangle, ChevronRight, ListTodo } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ToolSequenceGroup } from '@/components/agent-activity/tool-renderers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { GroupedMessageItem } from '@/lib/chat-protocol';
import { cn, formatRelativeTime } from '@/lib/utils';
import { AcpPlanView } from './acp-plan-view';
import { LatestThinking } from './latest-thinking';
import { summarizeLiveActivity } from './live-activity-summary';
import type { AcpPlanState, PendingRequest, ToolProgressInfo } from './reducer/types';

interface AgentLiveDockProps {
  workspaceId: string;
  groupedMessages: GroupedMessageItem[];
  pendingRequest: PendingRequest;
  running: boolean;
  starting: boolean;
  stopping: boolean;
  permissionMode: string | null;
  latestThinking: string | null;
  /** ACP agent plan state for structured task list rendering */
  acpPlan?: AcpPlanState | null;
  /** Tool progress map for ACP location rendering */
  toolProgress?: Map<string, ToolProgressInfo>;
  onApprovePermission?: (requestId: string, allow: boolean) => void;
  onJumpIn?: () => void;
  lastUpdatedAt?: string | null;
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
const DEFAULT_HEIGHT = 176;
const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;
const TIME_REFRESH_INTERVAL_MS = 15_000;

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

function getToneClass(tone: 'muted' | 'default' | 'success' | 'error'): string {
  if (tone === 'success') {
    return 'text-success';
  }
  if (tone === 'error') {
    return 'text-destructive';
  }
  if (tone === 'default') {
    return 'text-foreground';
  }
  return 'text-muted-foreground';
}

function getFileChipLabel(path: string, line?: number | null): string {
  const fileName = path.replace(/\\/g, '/').split('/').pop() || path;
  return line ? `${fileName}:${line}` : fileName;
}

type LiveActivitySummary = ReturnType<typeof summarizeLiveActivity>;

interface NeedsAttentionCardProps {
  needsAttention: LiveActivitySummary['needsAttention'];
  pendingRequest: PendingRequest;
  onApprovePermission?: (requestId: string, allow: boolean) => void;
  onJumpIn?: () => void;
  onOpenDetails: () => void;
}

function NeedsAttentionCard({
  needsAttention,
  pendingRequest,
  onApprovePermission,
  onJumpIn,
  onOpenDetails,
}: NeedsAttentionCardProps) {
  if (!needsAttention) {
    return null;
  }

  const needsPermissionAction =
    needsAttention.kind === 'permission' &&
    pendingRequest.type === 'permission' &&
    onApprovePermission;

  return (
    <div className="rounded border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-900/20 p-2 space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-900 dark:text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5" />
        Needs attention
        <span className="text-amber-800 dark:text-amber-300 font-normal">
          {needsAttention.message}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {needsPermissionAction && pendingRequest.type === 'permission' && (
          <>
            <Button
              type="button"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onApprovePermission(pendingRequest.request.requestId, true)}
            >
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onApprovePermission(pendingRequest.request.requestId, false)}
            >
              Deny
            </Button>
          </>
        )}
        {needsAttention.kind === 'error' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={onOpenDetails}
          >
            Open logs
          </Button>
        )}
        {onJumpIn && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={onJumpIn}
          >
            Message agent
          </Button>
        )}
      </div>
    </div>
  );
}

interface RecentMilestonesSectionProps {
  recent: LiveActivitySummary['recent'];
}

function RecentMilestonesSection({ recent }: RecentMilestonesSectionProps) {
  return (
    <section className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">Recent</div>
      {recent.length === 0 ? (
        <div className="rounded border bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
          Waiting for milestones...
        </div>
      ) : (
        <div className="rounded border bg-muted/20 px-2 py-1.5 space-y-1">
          {recent.map((milestone) => (
            <div key={milestone.id} className="flex items-center gap-2 min-w-0 text-xs">
              <span
                className={cn('h-1.5 w-1.5 rounded-full shrink-0', {
                  'bg-muted-foreground': milestone.tone === 'muted',
                  'bg-primary': milestone.tone === 'default',
                  'bg-success': milestone.tone === 'success',
                  'bg-destructive': milestone.tone === 'error',
                })}
              />
              <span className={cn('truncate', getToneClass(milestone.tone))}>
                {milestone.label}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface FilesTouchedSectionProps {
  filesTouched: LiveActivitySummary['filesTouched'];
  hiddenFileCount: number;
}

function FilesTouchedSection({ filesTouched, hiddenFileCount }: FilesTouchedSectionProps) {
  return (
    <section className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">Files touched</div>
      {filesTouched.length === 0 ? (
        <div className="rounded border bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
          No files yet
        </div>
      ) : (
        <div className="rounded border bg-muted/20 px-2 py-1.5">
          <div className="flex flex-wrap gap-1">
            {filesTouched.map((file) => (
              <button
                key={`${file.path}:${file.line ?? ''}`}
                type="button"
                className="rounded border bg-background px-1.5 py-0.5 text-[10px] font-mono text-blue-500 hover:text-blue-600 hover:underline truncate max-w-[220px]"
                title={file.line ? `${file.path}:${file.line}` : file.path}
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent('acp-open-file', {
                      detail: { path: file.path, line: file.line },
                    })
                  );
                }}
              >
                {getFileChipLabel(file.path, file.line)}
              </button>
            ))}
            {hiddenFileCount > 0 && (
              <span className="rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                +{hiddenFileCount} more
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface LiveActivityDetailsSheetProps {
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
  latestToolSequence: LiveActivitySummary['latestToolSequence'];
  toolWindowOpen: boolean;
  onToolWindowOpenChange: (open: boolean) => void;
  latestThinking: string | null;
  running: boolean;
  starting: boolean;
  hasAcpPlan: boolean;
  acpPlan?: AcpPlanState | null;
}

function LiveActivityDetailsSheet({
  detailsOpen,
  onDetailsOpenChange,
  latestToolSequence,
  toolWindowOpen,
  onToolWindowOpenChange,
  latestThinking,
  running,
  starting,
  hasAcpPlan,
  acpPlan,
}: LiveActivityDetailsSheetProps) {
  return (
    <Sheet open={detailsOpen} onOpenChange={onDetailsOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-[min(95vw,720px)] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Live activity details</SheetTitle>
          <SheetDescription>
            Raw tool payloads and full outputs are hidden from the main view.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {latestToolSequence ? (
            <section className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Latest tool call</div>
              <ToolSequenceGroup
                sequence={latestToolSequence}
                summaryOrder="latest-first"
                open={toolWindowOpen}
                onOpenChange={onToolWindowOpenChange}
                toolDetailsClassName="overflow-y-auto"
                toolDetailsMaxHeight={360}
              />
            </section>
          ) : (
            <div className="rounded border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              No tool details yet.
            </div>
          )}

          {latestThinking !== null && (
            <section className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">
                Latest thinking (full)
              </div>
              <LatestThinking thinking={latestThinking} running={running || starting} />
            </section>
          )}

          {hasAcpPlan && acpPlan && (
            <section className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Agent plan</div>
              <AcpPlanView entries={acpPlan.entries} />
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export const AgentLiveDock = memo(function AgentLiveDock({
  workspaceId,
  groupedMessages,
  pendingRequest,
  running,
  starting,
  stopping,
  permissionMode,
  latestThinking,
  acpPlan,
  toolProgress,
  onApprovePermission,
  onJumpIn,
  lastUpdatedAt,
  className,
}: AgentLiveDockProps) {
  const skipNextPersistRef = useRef(false);
  const [toolWindowOpen, setToolWindowOpen] = useState(true);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [isDragging, setIsDragging] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [, setTimeTick] = useState(0);
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

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTimeTick((tick) => tick + 1);
    }, TIME_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, []);

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

  const summary = useMemo(
    () =>
      summarizeLiveActivity({
        groupedMessages,
        latestThinking,
        running,
        starting,
        stopping,
        pendingRequest,
        permissionMode,
        toolProgress,
      }),
    [
      groupedMessages,
      latestThinking,
      running,
      starting,
      stopping,
      pendingRequest,
      permissionMode,
      toolProgress,
    ]
  );

  const hasAcpPlan = acpPlan != null && acpPlan.entries.length > 0;
  const hasSummaryContent =
    summary.latestThinkingSnippet !== null ||
    summary.recent.length > 0 ||
    summary.filesTouched.length > 0 ||
    summary.needsAttention !== null;
  const hasDetailsContent =
    hasAcpPlan || summary.latestToolSequence !== null || latestThinking !== null;
  const hasContent = hasSummaryContent || hasDetailsContent;
  const { label, tone } = getPhaseLabel({ running, starting, stopping, permissionMode });

  const updatedLabel = lastUpdatedAt ? `updated ${formatRelativeTime(lastUpdatedAt)}` : null;

  if (!(hasContent || running || starting || stopping || permissionMode)) {
    return null;
  }

  return (
    <div className={cn('bg-muted/20 border-b relative', className)}>
      <div className="px-4 py-3 flex flex-col" style={{ height: `${height}px` }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-muted-foreground">Live activity</span>
          <Badge variant={tone} className="text-[10px] px-1.5 py-0">
            {label}
          </Badge>
          {summary.latestThinkingSnippet && (
            <span
              className="text-xs italic text-muted-foreground truncate min-w-0"
              title={summary.latestThinkingSnippet}
            >
              {summary.latestThinkingSnippet}
            </span>
          )}
          {updatedLabel && (
            <span className="ml-auto text-[10px] text-muted-foreground whitespace-nowrap">
              {updatedLabel}
            </span>
          )}
          {onJumpIn && (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2" onClick={onJumpIn}>
              Jump in
            </Button>
          )}
        </div>

        <div className="mt-2 min-h-0 space-y-2 overflow-y-auto">
          <NeedsAttentionCard
            needsAttention={summary.needsAttention}
            pendingRequest={pendingRequest}
            onApprovePermission={onApprovePermission}
            onJumpIn={onJumpIn}
            onOpenDetails={() => setDetailsOpen(true)}
          />

          <section className="space-y-1">
            <div className="text-[10px] font-medium text-muted-foreground">Now</div>
            <div className="rounded border bg-muted/30 px-2 py-1.5 text-xs min-w-0">
              <span className={cn('truncate block', getToneClass(summary.now.tone))}>
                {summary.now.label}
              </span>
            </div>
          </section>

          <RecentMilestonesSection recent={summary.recent} />
          <FilesTouchedSection
            filesTouched={summary.filesTouched}
            hiddenFileCount={summary.hiddenFileCount}
          />

          {hasDetailsContent && (
            <div className="pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setDetailsOpen(true)}
              >
                <ListTodo className="h-3.5 w-3.5" />
                View details
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>

      <LiveActivityDetailsSheet
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
        latestToolSequence={summary.latestToolSequence}
        toolWindowOpen={toolWindowOpen}
        onToolWindowOpenChange={setToolWindowOpen}
        latestThinking={latestThinking}
        running={running}
        starting={starting}
        hasAcpPlan={hasAcpPlan}
        acpPlan={acpPlan}
      />

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
