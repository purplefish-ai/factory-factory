'use client';

import { TaskState } from '@prisma-gen/browser';
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
  PENDING: 'outline',
  ASSIGNED: 'default',
  IN_PROGRESS: 'default',
  REVIEW: 'default',
  BLOCKED: 'destructive',
  COMPLETED: 'secondary',
  FAILED: 'destructive',
};

export default function ProjectTasksPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [stateFilter, setStateFilter] = useState<string>('all');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  const { data: tasks, isLoading } = trpc.task.list.useQuery(
    {
      state: stateFilter !== 'all' ? (stateFilter as TaskState) : undefined,
    },
    { enabled: !!project?.id, refetchInterval: 5000 }
  );

  if (isLoading || !project) {
    return <Loading message="Loading tasks..." />;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Tasks" description={project.name} />

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
        {!tasks || tasks.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyTitle>No tasks found</EmptyTitle>
              <EmptyDescription>
                Tasks are created automatically when epics are processed.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Epic</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>PR</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${slug}/tasks/${task.id}`}
                      className="font-medium hover:underline"
                    >
                      {task.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {task.parent && (
                      <Link
                        href={`/projects/${slug}/epics/${task.parentId}`}
                        className="text-sm text-primary hover:underline"
                      >
                        {task.parent.title.length > 30
                          ? `${task.parent.title.slice(0, 30)}...`
                          : task.parent.title}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={stateVariants[task.state] || 'default'}>{task.state}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {task.assignedAgentId ? (
                      <Link
                        href={`/projects/${slug}/agents/${task.assignedAgentId}`}
                        className="text-primary hover:underline"
                      >
                        View Worker
                      </Link>
                    ) : (
                      <span>-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {task.prUrl ? (
                      <a
                        href={task.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        View PR
                      </a>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/projects/${slug}/tasks/${task.id}`}>Details</Link>
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
