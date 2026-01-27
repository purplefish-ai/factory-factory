'use client';

import type { Workspace } from '@prisma-gen/browser';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { Loading } from '@/frontend/components/loading';
import { trpc } from '../../../../../frontend/lib/trpc';

export default function NewWorkspacePage() {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [branchName, setBranchName] = useState('');
  const [error, setError] = useState('');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });

  const createWorkspace = trpc.workspace.create.useMutation({
    onSuccess: (workspace: Workspace) => {
      router.push(`/projects/${slug}/workspaces/${workspace.id}`);
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

    if (!name.trim()) {
      setError('Name is required');
      return;
    }

    createWorkspace.mutate({
      projectId: project.id,
      name,
      description: description || undefined,
      branchName: branchName || undefined,
    });
  };

  if (!project) {
    return <Loading message="Loading..." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/projects/${slug}/workspaces`}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create New Workspace</h1>
          <p className="text-muted-foreground mt-1">{project.name}</p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="E.g., Feature Development"
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
                placeholder="Brief description of what this workspace is for"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="branchName">Branch Name</Label>
              <p className="text-xs text-muted-foreground">
                Git branch for this workspace (optional)
              </p>
              <Input
                id="branchName"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="E.g., feature/my-feature"
                className="font-mono"
              />
            </div>

            {createWorkspace.isPending &&
              (project.startupScriptCommand || project.startupScriptPath) && (
                <Alert>
                  <AlertDescription className="flex items-center gap-2">
                    <Spinner className="h-4 w-4" />
                    Running startup script... This may take a few minutes.
                  </AlertDescription>
                </Alert>
              )}

            <div className="flex justify-end gap-4">
              <Button variant="outline" asChild disabled={createWorkspace.isPending}>
                <Link href={`/projects/${slug}/workspaces`}>Cancel</Link>
              </Button>
              <Button type="submit" disabled={createWorkspace.isPending}>
                {createWorkspace.isPending && <Spinner className="mr-2 h-4 w-4" />}
                {createWorkspace.isPending ? 'Creating...' : 'Create Workspace'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
