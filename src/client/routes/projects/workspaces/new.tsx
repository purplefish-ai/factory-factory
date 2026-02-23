import type { Workspace } from '@prisma-gen/browser';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { createOptimisticWorkspaceCacheData } from '@/client/lib/workspace-cache-helpers';
import { FactoryConfigScripts } from '@/components/factory-config-scripts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

export default function NewWorkspacePage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [branchName, setBranchName] = useState('');
  const [error, setError] = useState('');

  const { data: project } = trpc.project.getBySlug.useQuery({ slug });
  const { data: factoryConfig } = trpc.workspace.getFactoryConfig.useQuery(
    { projectId: project?.id ?? '' },
    { enabled: !!project?.id }
  );

  const utils = trpc.useUtils();
  const createWorkspace = trpc.workspace.create.useMutation({
    onSuccess: (workspace: Workspace) => {
      // Optimistically populate the workspace detail query cache so the status
      // is immediately visible when navigating to the detail page
      utils.workspace.get.setData({ id: workspace.id }, (old) => {
        // If there's already data (shouldn't happen for a new workspace), keep it
        if (old) {
          return old;
        }

        return createOptimisticWorkspaceCacheData(workspace);
      });

      void navigate(`/projects/${slug}/workspaces/${workspace.id}`);
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
      type: 'MANUAL',
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
          <Link to={`/projects/${slug}/workspaces`}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create New Workspace</h1>
          <p className="text-muted-foreground mt-1">{project.name}</p>
        </div>
      </div>

      {factoryConfig && <FactoryConfigScripts factoryConfig={factoryConfig} variant="alert" />}

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

            <div className="flex justify-end gap-4">
              <Button variant="outline" asChild disabled={createWorkspace.isPending}>
                <Link to={`/projects/${slug}/workspaces`}>Cancel</Link>
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
