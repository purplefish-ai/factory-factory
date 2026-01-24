'use client';

import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { trpc } from '../../../frontend/lib/trpc';

export default function NewProjectPage() {
  const router = useRouter();
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState('');

  const createProject = trpc.project.create.useMutation({
    onSuccess: () => {
      router.push('/projects');
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!repoPath.trim()) {
      setError('Repository path is required');
      return;
    }

    createProject.mutate({ repoPath });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/projects">
            <ArrowLeftIcon className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Add Project</h1>
          <p className="text-muted-foreground mt-1">
            Add a repository to manage with FactoryFactory
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Repository Details</CardTitle>
          <CardDescription>
            Provide the path to a git repository on your local machine.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="repoPath">Repository Path</Label>
              <Input
                type="text"
                id="repoPath"
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                className="font-mono"
                placeholder="/Users/you/code/my-project"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Path to a git repository on your local machine. The project name will be derived
                from the directory name.
              </p>
            </div>

            <div className="flex justify-end gap-4">
              <Button variant="secondary" asChild>
                <Link href="/projects">Cancel</Link>
              </Button>
              <Button type="submit" disabled={createProject.isPending}>
                {createProject.isPending && <Spinner className="mr-2" />}
                {createProject.isPending ? 'Adding...' : 'Add Project'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
