'use client';

import type { Task, TaskState } from '@prisma-gen/browser';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
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
import { StateFilter, stateVariants } from '@/frontend/components/state-filter';
import { trpc } from '../../../../frontend/lib/trpc';

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
    <div className="space-y-4">
      <PageHeader title="Epics" description={project.name}>
        <Button asChild>
          <Link href={`/projects/${slug}/epics/new`}>
            <Plus className="h-4 w-4 mr-2" />
            New Epic
          </Link>
        </Button>
      </PageHeader>

      <StateFilter value={stateFilter} onChange={setStateFilter} />

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
                        {task.description.length > 100
                          ? `${task.description.slice(0, 100)}...`
                          : task.description}
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
