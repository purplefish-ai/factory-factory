'use client';

import type { Workspace, WorkspaceStatus } from '@prisma-gen/browser';
import { Kanban, List, Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { KanbanBoard } from '@/frontend/components/kanban';
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { trpc } from '../../../../frontend/lib/trpc';

const statusVariants: Record<string, 'default' | 'secondary' | 'outline'> = {
  ACTIVE: 'default',
  COMPLETED: 'secondary',
  ARCHIVED: 'outline',
};

const workspaceStatuses: WorkspaceStatus[] = ['ACTIVE', 'COMPLETED', 'ARCHIVED'];

type ViewMode = 'list' | 'board';

export default function ProjectWorkspacesPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('board');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  // Only fetch list data when in list view
  const { data: workspaces, isLoading } = trpc.workspace.list.useQuery(
    {
      projectId: project?.id ?? '',
      status: statusFilter !== 'all' ? (statusFilter as WorkspaceStatus) : undefined,
    },
    { enabled: !!project?.id && viewMode === 'list', refetchInterval: 5000 }
  );

  if (!project) {
    return <Loading message="Loading project..." />;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Workspaces" description={project.name}>
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={viewMode}
            onValueChange={(value) => value && setViewMode(value as ViewMode)}
            size="sm"
          >
            <ToggleGroupItem value="board" aria-label="Board view">
              <Kanban className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="List view">
              <List className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button asChild>
            <Link href={`/projects/${slug}/workspaces/new`}>
              <Plus className="h-4 w-4 mr-2" />
              New Workspace
            </Link>
          </Button>
        </div>
      </PageHeader>

      {viewMode === 'board' ? (
        <KanbanBoard projectId={project.id} projectSlug={slug} />
      ) : (
        <>
          <Card>
            <CardContent className="pt-6">
              <div className="flex gap-4 items-center">
                <label className="text-sm font-medium">Filter by status:</label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="All Statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    {workspaceStatuses.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            {isLoading ? (
              <Loading message="Loading workspaces..." />
            ) : !workspaces || workspaces.length === 0 ? (
              <Empty className="py-12">
                <EmptyHeader>
                  <EmptyTitle>No workspaces found</EmptyTitle>
                  <EmptyDescription>Get started by creating your first workspace.</EmptyDescription>
                </EmptyHeader>
                <Button asChild>
                  <Link href={`/projects/${slug}/workspaces/new`}>Create your first workspace</Link>
                </Button>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sessions</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workspaces.map((workspace: Workspace & { claudeSessions?: unknown[] }) => (
                    <TableRow key={workspace.id}>
                      <TableCell>
                        <Link
                          href={`/projects/${slug}/workspaces/${workspace.id}`}
                          className="font-medium hover:underline"
                        >
                          {workspace.name}
                        </Link>
                        {workspace.description && (
                          <p className="text-sm text-muted-foreground truncate max-w-md">
                            {workspace.description.length > 100
                              ? `${workspace.description.slice(0, 100)}...`
                              : workspace.description}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariants[workspace.status] || 'default'}>
                          {workspace.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {workspace.claudeSessions?.length ?? 0} sessions
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-sm">
                        {workspace.branchName || '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(workspace.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/projects/${slug}/workspaces/${workspace.id}`}>View</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
