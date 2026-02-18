import { Archive, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ProjectSettingsDialog } from '@/components/project/project-settings-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { trpc } from '@/frontend/lib/trpc';
import { useIsMobile } from '@/hooks/use-mobile';

function ProjectActions({
  projectId,
  projectName,
  startupScriptCommand,
  startupScriptPath,
  archivePending,
  onArchive,
}: {
  projectId: string;
  projectName: string;
  startupScriptCommand: string | null;
  startupScriptPath: string | null;
  archivePending: boolean;
  onArchive: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <ProjectSettingsDialog
        projectId={projectId}
        projectName={projectName}
        currentStartupScriptCommand={startupScriptCommand}
        currentStartupScriptPath={startupScriptPath}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={onArchive}
            disabled={archivePending}
            className="hover:bg-destructive/10 hover:text-destructive"
          >
            {archivePending ? <Spinner className="size-4" /> : <Archive className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Archive</TooltipContent>
      </Tooltip>
    </div>
  );
}

export default function ProjectsListPage() {
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [projectToArchive, setProjectToArchive] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const {
    data: projects,
    isLoading,
    refetch,
  } = trpc.project.list.useQuery({ isArchived: false }, { refetchInterval: 10_000 });

  const archiveMutation = trpc.project.archive.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 p-6">
        <Spinner className="size-5" />
        <span className="text-muted-foreground">Loading projects...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-muted-foreground mt-1">Manage your repositories</p>
        </div>
        <Button asChild size={isMobile ? 'sm' : 'default'}>
          <Link to="/projects/new">
            <Plus className="size-5" />
            New Project
          </Link>
        </Button>
      </div>

      {/* Project List */}
      <div className="bg-card rounded-lg shadow-sm overflow-hidden border">
        {!projects || projects.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">
            <p>No projects found.</p>
            <Link
              to="/projects/new"
              className="text-primary hover:text-primary/80 mt-2 inline-block"
            >
              Create your first project
            </Link>
          </div>
        ) : isMobile ? (
          <div className="space-y-2 p-2">
            {projects.map((project) => (
              <div key={project.id} className="rounded-md border bg-background p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="font-medium text-foreground truncate">{project.name}</div>
                    <div className="text-sm text-muted-foreground truncate">{project.slug}</div>
                    <Badge variant="secondary" className="max-w-full truncate font-mono text-xs">
                      {project.repoPath}
                    </Badge>
                  </div>
                  <ProjectActions
                    projectId={project.id}
                    projectName={project.name}
                    startupScriptCommand={project.startupScriptCommand}
                    startupScriptPath={project.startupScriptPath}
                    archivePending={archiveMutation.isPending}
                    onArchive={() => {
                      setProjectToArchive(project.id);
                      setArchiveDialogOpen(true);
                    }}
                  />
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="truncate">Branch: {project.defaultBranch}</span>
                  <span>
                    Workspaces:{' '}
                    {'_count' in project
                      ? (project._count as { workspaces: number }).workspaces
                      : '-'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Repository Path</TableHead>
                <TableHead>Default Branch</TableHead>
                <TableHead>Workspaces</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <TableRow key={project.id}>
                  <TableCell>
                    <div>
                      <div className="font-medium text-foreground">{project.name}</div>
                      <div className="text-sm text-muted-foreground">{project.slug}</div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {project.repoPath}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {project.defaultBranch}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {'_count' in project
                      ? (project._count as { workspaces: number }).workspaces
                      : '-'}
                  </TableCell>
                  <TableCell>
                    <ProjectActions
                      projectId={project.id}
                      projectName={project.name}
                      startupScriptCommand={project.startupScriptCommand}
                      startupScriptPath={project.startupScriptPath}
                      archivePending={archiveMutation.isPending}
                      onArchive={() => {
                        setProjectToArchive(project.id);
                        setArchiveDialogOpen(true);
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        title="Archive Project"
        description="Are you sure you want to archive this project?"
        confirmText="Archive"
        variant="destructive"
        onConfirm={() => {
          if (projectToArchive) {
            archiveMutation.mutate({ id: projectToArchive });
          }
          setArchiveDialogOpen(false);
        }}
        isPending={archiveMutation.isPending}
      />
    </div>
  );
}
