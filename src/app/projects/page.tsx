'use client';

import { Archive, Plus } from 'lucide-react';
import Link from 'next/link';
import { ProjectSettingsDialog } from '@/components/project/project-settings-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { trpc } from '../../frontend/lib/trpc';

export default function ProjectsPage() {
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
    <div className="space-y-4 p-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Projects</h1>
          <p className="text-muted-foreground mt-1">Manage your repositories</p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
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
              href="/projects/new"
              className="text-primary hover:text-primary/80 mt-2 inline-block"
            >
              Create your first project
            </Link>
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
                    <div className="flex items-center gap-1">
                      <ProjectSettingsDialog
                        projectId={project.id}
                        projectName={project.name}
                        currentStartupScriptCommand={project.startupScriptCommand}
                        currentStartupScriptPath={project.startupScriptPath}
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              if (confirm('Are you sure you want to archive this project?')) {
                                archiveMutation.mutate({ id: project.id });
                              }
                            }}
                            disabled={archiveMutation.isPending}
                            className="hover:bg-destructive/10 hover:text-destructive"
                          >
                            {archiveMutation.isPending ? (
                              <Spinner className="size-4" />
                            ) : (
                              <Archive className="size-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Archive</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
