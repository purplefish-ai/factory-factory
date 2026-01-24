'use client';

import type { Task } from '@prisma-gen/browser';
import { TaskState } from '@prisma-gen/browser';
import { Plus } from 'lucide-react';
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
import { Loading } from '@/frontend/components/loading';
import { PageHeader } from '@/frontend/components/page-header';
import { trpc } from '../../../../frontend/lib/trpc';

const stateVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PLANNING: 'secondary',
  PLANNED: 'secondary',
  PENDING: 'outline',
  ASSIGNED: 'default',
  IN_PROGRESS: 'default',
  REVIEW: 'default',
  BLOCKED: 'destructive',
  COMPLETED: 'secondary',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

export default function ProjectEpicsPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [stateFilter, setStateFilter] = useState<string>('all');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  const { data: topLevelTasks, isLoading } = trpc.task.list.useQuery(
    {
      state: stateFilter !== 'all' ? (stateFilter as TaskState) : undefined,
      isTopLevel: true,
    },
    { enabled: !!project?.id, refetchInterval: 5000 }
  );

  if (isLoading || !project) {
    return <Loading message="Loading epics..." />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Epics" description={project.name}>
        <Button asChild>
          <Link href={`/projects/${slug}/epics/new`}>
            <Plus className="h-4 w-4 mr-2" />
            New Epic
          </Link>
        </Button>
      </PageHeader>

      <Card>
        <CardContent className="pt-6">
          <div className="flex gap-4 items-center">
            <label className="text-sm font-medium">Filter by state:</label>
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All States" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All States</SelectItem>
                {Object.values(TaskState).map((state) => (
                  <SelectItem key={state} value={state}>
                    {state}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        {!topLevelTasks || topLevelTasks.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyTitle>No epics found</EmptyTitle>
              <EmptyDescription>Get started by creating your first epic.</EmptyDescription>
            </EmptyHeader>
            <Button asChild>
              <Link href={`/projects/${slug}/epics/new`}>Create your first epic</Link>
            </Button>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Tasks</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topLevelTasks.map((task: Task & { children?: unknown[] }) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${slug}/epics/${task.id}`}
                      className="font-medium hover:underline"
                    >
                      {task.title}
                    </Link>
                    {task.description && (
                      <p className="text-sm text-muted-foreground truncate max-w-md">
                        {task.description.slice(0, 100)}...
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={stateVariants[task.state] || 'default'}>{task.state}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {task.children?.length ?? 0} tasks
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(task.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/projects/${slug}/epics/${task.id}`}>View</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
