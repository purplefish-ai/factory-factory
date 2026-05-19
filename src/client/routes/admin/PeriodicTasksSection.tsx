import { Calendar, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { readSelectedProjectSlug, writeSelectedProjectSlug } from '@/client/lib/project-selection';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const NOW_THRESHOLD_SECONDS = 5;

export type AdminProject = { id: string; slug: string; name: string };
type PeriodicTaskCadence = 'EVERY_MINUTE' | 'EVERY_FIVE_MINUTES' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

export function formatRelativeTime(date: Date, nowMs = Date.now()): string {
  const diffMs = date.getTime() - nowMs;
  const diffSec = Math.round(diffMs / 1000);
  if (Math.abs(diffSec) <= NOW_THRESHOLD_SECONDS) {
    return 'now';
  }

  const duration = formatDuration(Math.abs(diffSec));
  if (diffSec < 0) {
    return `${duration} overdue`;
  }

  return `in ${duration}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export function getInitialProjectSlug(
  projects: AdminProject[],
  storage: Pick<Storage, 'getItem'> = localStorage
): string {
  return readSelectedProjectSlug(storage) || projects[0]?.slug || '';
}

export function PeriodicTasksSection({ projects }: { projects: AdminProject[] }) {
  const [selectedSlug, setSelectedSlug] = useState<string>(() => getInitialProjectSlug(projects));
  const selectedProject = projects.find((p) => p.slug === selectedSlug) ?? projects[0];

  useEffect(() => {
    if (!selectedProject || selectedProject.slug === selectedSlug) {
      return;
    }
    setSelectedSlug(selectedProject.slug);
    writeSelectedProjectSlug(selectedProject.slug);
  }, [selectedProject, selectedSlug]);

  const handleProjectChange = (slug: string) => {
    setSelectedSlug(slug);
    writeSelectedProjectSlug(slug);
  };

  if (!selectedProject) {
    return <p className="text-sm text-muted-foreground">No projects found.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Select value={selectedProject.slug} onValueChange={handleProjectChange}>
          <SelectTrigger className="w-auto max-w-xs">
            <SelectValue placeholder="Select a project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.slug}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <PeriodicTaskList projectId={selectedProject.id} />
    </div>
  );
}

function PeriodicTaskList({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const { data: tasks, isLoading } = trpc.periodicTask.list.useQuery(
    { projectId },
    { refetchInterval: 10_000 }
  );

  const deleteMutation = trpc.periodicTask.delete.useMutation({
    onSuccess: () => {
      toast.success('Periodic task deleted');
      utils.periodicTask.list.invalidate({ projectId });
    },
    onError: (error) => toast.error(`Delete failed: ${error.message}`),
  });

  const toggleMutation = trpc.periodicTask.toggleEnabled.useMutation({
    onSuccess: () => {
      utils.periodicTask.list.invalidate({ projectId });
    },
    onError: (error) => toast.error(`Toggle failed: ${error.message}`),
  });

  const updateMutation = trpc.periodicTask.update.useMutation({
    onSuccess: () => {
      toast.success('Periodic task updated');
      utils.periodicTask.list.invalidate({ projectId });
    },
    onError: (error) => toast.error(`Update failed: ${error.message}`),
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="w-5 h-5" />
            Periodic Tasks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="w-5 h-5" />
          Periodic Tasks
        </CardTitle>
        <CardDescription>Recurring tasks that create workspaces on a schedule</CardDescription>
      </CardHeader>
      <CardContent>
        {!tasks || tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No periodic tasks yet. Create one from the workspace launch dropdown.
          </p>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => (
              <PeriodicTaskRow
                key={task.id}
                task={task}
                onToggle={(enabled) => toggleMutation.mutate({ id: task.id, enabled })}
                onDelete={() => deleteMutation.mutate({ id: task.id })}
                onUpdate={(data) => updateMutation.mutate({ id: task.id, ...data })}
                isUpdating={updateMutation.isPending || toggleMutation.isPending}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ExecutionStatusBadge({ status }: { status: string }) {
  const variantMap: Record<string, 'default' | 'secondary' | 'destructive'> = {
    PR_CREATED: 'default',
    RUNNING: 'secondary',
  };
  const labelMap: Record<string, string> = {
    PR_CREATED: 'PR Created',
    RUNNING: 'Running',
    FAILED: 'Failed',
    SKIPPED: 'Skipped',
  };
  return (
    <Badge variant={variantMap[status] ?? 'destructive'} className="text-[10px]">
      {labelMap[status] ?? status}
    </Badge>
  );
}

const LONG_CADENCES = new Set(['DAILY', 'WEEKLY', 'MONTHLY']);

function resolveTimezone(
  scheduledTime: string,
  prevScheduledTime: string | null,
  prevTimezone: string | null
): string {
  if (scheduledTime !== prevScheduledTime || !prevTimezone) {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return prevTimezone;
}

function formatScheduledTime(scheduledTime: string, timezone: string): string {
  const parts = scheduledTime.split(':').map(Number);
  const hours = parts[0] ?? 0;
  const minutes = parts[1] ?? 0;
  const probe = new Date();
  probe.setHours(hours, minutes, 0, 0);
  const timePart = probe.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tzShort = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'short',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')?.value;
  return tzShort ? `${timePart} (${tzShort})` : timePart;
}

function PeriodicTaskRow({
  task,
  onToggle,
  onDelete,
  onUpdate,
  isUpdating,
}: {
  task: {
    id: string;
    name: string;
    prompt: string;
    cadence: string;
    isEnabled: boolean;
    nextRunAt: Date;
    lastRunAt: Date | null;
    scheduledTime: string | null;
    timezone: string | null;
    executions: Array<{
      id: string;
      status: string;
      prUrl: string | null;
      startedAt: Date;
      completedAt: Date | null;
    }>;
  };
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onUpdate: (data: {
    name?: string;
    prompt?: string;
    cadence?: PeriodicTaskCadence;
    scheduledTime?: string | null;
    timezone?: string | null;
  }) => void;
  isUpdating: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(task.name);
  const [editPrompt, setEditPrompt] = useState(task.prompt);
  const [editCadence, setEditCadence] = useState(task.cadence);
  const [editScheduledTime, setEditScheduledTime] = useState(task.scheduledTime ?? '');
  const [showExecutions, setShowExecutions] = useState(false);

  const handleSave = () => {
    const hasSchedule = LONG_CADENCES.has(editCadence) && !!editScheduledTime;
    const newScheduledTime = hasSchedule ? editScheduledTime : null;
    const newTimezone = hasSchedule
      ? resolveTimezone(editScheduledTime, task.scheduledTime, task.timezone)
      : null;
    onUpdate({
      name: editName !== task.name ? editName : undefined,
      prompt: editPrompt !== task.prompt ? editPrompt : undefined,
      cadence: editCadence !== task.cadence ? (editCadence as PeriodicTaskCadence) : undefined,
      scheduledTime: newScheduledTime !== task.scheduledTime ? newScheduledTime : undefined,
      timezone: newTimezone !== task.timezone ? newTimezone : undefined,
    });
    setEditing(false);
  };

  const cadenceLabels: Record<string, string> = {
    EVERY_MINUTE: 'Every minute',
    EVERY_FIVE_MINUTES: 'Every 5 minutes',
    DAILY: 'Daily',
    WEEKLY: 'Weekly',
    MONTHLY: 'Monthly',
  };
  const cadenceLabel = cadenceLabels[task.cadence] ?? task.cadence;
  const latestExecution = task.executions[0];

  const toggleEdit = () => {
    setEditName(task.name);
    setEditPrompt(task.prompt);
    setEditCadence(task.cadence);
    setEditScheduledTime(task.scheduledTime ?? '');
    setEditing(!editing);
  };

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Switch
            checked={task.isEnabled}
            onCheckedChange={onToggle}
            disabled={isUpdating}
            className="shrink-0"
          />
          <span className="font-medium text-sm truncate">{task.name}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {cadenceLabel}
          </Badge>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2">{task.prompt}</p>

      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        {task.lastRunAt && <span>Last run: {new Date(task.lastRunAt).toLocaleString()}</span>}
        <span title={new Date(task.nextRunAt).toLocaleString()}>
          Next run: {formatRelativeTime(new Date(task.nextRunAt))}
        </span>
        {LONG_CADENCES.has(task.cadence) && task.scheduledTime && task.timezone && (
          <span>at {formatScheduledTime(task.scheduledTime, task.timezone)}</span>
        )}
        {latestExecution && <ExecutionStatusBadge status={latestExecution.status} />}
      </div>

      {editing && (
        <div className="space-y-2 pt-2 border-t">
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input
              className="h-7 text-xs"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Prompt</Label>
            <Textarea
              className="text-xs min-h-[60px]"
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Cadence</Label>
            <Select value={editCadence} onValueChange={setEditCadence}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EVERY_MINUTE">Every minute (testing)</SelectItem>
                <SelectItem value="EVERY_FIVE_MINUTES">Every 5 minutes (testing)</SelectItem>
                <SelectItem value="DAILY">Daily</SelectItem>
                <SelectItem value="WEEKLY">Weekly</SelectItem>
                <SelectItem value="MONTHLY">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {LONG_CADENCES.has(editCadence) && (
            <div className="space-y-1">
              <Label className="text-xs">Run time (optional)</Label>
              <Input
                type="time"
                className="h-7 text-xs"
                value={editScheduledTime}
                onChange={(e) => setEditScheduledTime(e.target.value)}
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={isUpdating}>
              Save
            </Button>
          </div>
        </div>
      )}

      {task.executions.length > 0 && (
        <div>
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground underline"
            onClick={() => setShowExecutions(!showExecutions)}
          >
            {showExecutions ? 'Hide' : 'Show'} execution history ({task.executions.length})
          </button>
          {showExecutions && (
            <div className="mt-2 space-y-1">
              {task.executions.map((exec) => (
                <div
                  key={exec.id}
                  className="flex items-center gap-2 text-[10px] text-muted-foreground"
                >
                  <ExecutionStatusBadge status={exec.status} />
                  <span>{new Date(exec.startedAt).toLocaleString()}</span>
                  {exec.prUrl && (
                    <a
                      href={exec.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      PR
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
