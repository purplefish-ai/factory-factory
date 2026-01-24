'use client';

import type { Task } from '@prisma-gen/browser';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '../../../../../frontend/lib/trpc';

export default function NewEpicPage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [design, setDesign] = useState('');
  const [error, setError] = useState('');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  const createTask = trpc.task.create.useMutation({
    onSuccess: (task: Task) => {
      router.push(`/projects/${slug}/epics/${task.id}`);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!project?.id) {
      setError('Project not found');
      return;
    }

    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    createTask.mutate({ title, description, design, parentId: null });
  };

  if (!project) {
    return <Loading message="Loading..." />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/projects/${slug}/epics`}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create New Epic</h1>
          <p className="text-muted-foreground mt-1">{project.name}</p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="E.g., Add user authentication system"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Brief description of what this epic accomplishes"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="design">Design Document (Markdown)</Label>
              <p className="text-xs text-muted-foreground">
                Detailed technical design for the supervisor agent to follow
              </p>
              <Textarea
                id="design"
                value={design}
                onChange={(e) => setDesign(e.target.value)}
                rows={15}
                className="font-mono text-sm"
                placeholder={`## Overview
Describe the feature at a high level...

## Requirements
- Requirement 1
- Requirement 2

## Technical Design
Describe the implementation approach...

## Tasks
1. Create database schema
2. Implement API endpoints
3. Build frontend components
4. Write tests`}
              />
            </div>

            <div className="flex justify-end gap-4">
              <Button variant="outline" asChild>
                <Link href={`/projects/${slug}/epics`}>Cancel</Link>
              </Button>
              <Button type="submit" disabled={createTask.isPending}>
                {createTask.isPending ? 'Creating...' : 'Create Epic'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
