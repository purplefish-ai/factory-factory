import { ExternalLink, Network, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// =============================================================================
// New Child Workspace Dialog
// =============================================================================

interface NewChildWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentWorkspaceId: string;
}

function NewChildWorkspaceDialog({
  open,
  onOpenChange,
  parentWorkspaceId,
}: NewChildWorkspaceDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [reportBackOn, setReportBackOn] = useState('');

  const { data: projects } = trpc.project.list.useQuery();
  const utils = trpc.useUtils();

  const createChild = trpc.workspace.createChild.useMutation({
    onSuccess: () => {
      void utils.workspace.listChildren.invalidate({ parentWorkspaceId });
      onOpenChange(false);
      // Reset form
      setName('');
      setDescription('');
      setProjectId('');
      setInitialPrompt('');
      setReportBackOn('');
    },
    onError: (error) => {
      toast.error(`Failed to create child workspace: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!(name.trim() && projectId)) {
      return;
    }
    createChild.mutate({
      parentWorkspaceId,
      projectId,
      name: name.trim(),
      description: description.trim() || undefined,
      initialPrompt: initialPrompt.trim() || undefined,
      reportBackOn: reportBackOn.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Child Workspace</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="child-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id="child-project">
                <SelectValue placeholder="Select a project..." />
              </SelectTrigger>
              <SelectContent>
                {projects?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="child-name">Name</Label>
            <Input
              id="child-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Implement auth module"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="child-description">Description (optional)</Label>
            <Input
              id="child-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="child-prompt">Initial prompt (optional)</Label>
            <Textarea
              id="child-prompt"
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder="Starting task for the child workspace..."
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="child-report-back">Report back when (optional)</Label>
            <Input
              id="child-report-back"
              value={reportBackOn}
              onChange={(e) => setReportBackOn(e.target.value)}
              placeholder="e.g. when a PR is opened"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!(name.trim() && projectId) || createChild.isPending}>
              {createChild.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Child Workspaces Panel
// =============================================================================

function statusColor(status: string): string {
  switch (status) {
    case 'READY':
      return 'bg-green-500';
    case 'NEW':
    case 'PROVISIONING':
      return 'bg-yellow-500 animate-pulse';
    case 'FAILED':
      return 'bg-red-500';
    case 'ARCHIVED':
    case 'ARCHIVING':
      return 'bg-muted-foreground';
    default:
      return 'bg-blue-500';
  }
}

interface ChildWorkspacesPanelProps {
  workspaceId: string;
}

export function ChildWorkspacesPanel({ workspaceId }: ChildWorkspacesPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: children, isLoading } = trpc.workspace.listChildren.useQuery(
    { parentWorkspaceId: workspaceId },
    { refetchInterval: 15_000 }
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-1.5">
          <Network className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Child Workspaces</span>
          {children && children.length > 0 && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
              {children.length}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setDialogOpen(true)}
          title="New child workspace"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Loading...
          </div>
        )}
        {!isLoading && children?.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
            <Network className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No child workspaces yet.</p>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              New Child Workspace
            </Button>
          </div>
        )}
        {children && children.length > 0 && (
          <ul className="divide-y divide-border/50">
            {children.map((child) => (
              <li key={child.id}>
                <Link
                  to={`/projects/${child.projectSlug}/workspaces/${child.id}`}
                  className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors group"
                >
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 rounded-full shrink-0',
                      statusColor(child.status)
                    )}
                  />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="text-sm font-medium truncate">{child.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {child.projectName}
                      {child.cachedKanbanColumn && (
                        <>
                          {' '}
                          &middot;{' '}
                          <span className="capitalize">
                            {child.cachedKanbanColumn.toLowerCase().replace('_', ' ')}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50 group-hover:text-muted-foreground shrink-0 mt-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <NewChildWorkspaceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        parentWorkspaceId={workspaceId}
      />
    </div>
  );
}
