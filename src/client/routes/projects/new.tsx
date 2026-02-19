import { ArrowLeftIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { DataImportButton } from '@/components/data-import/data-import-button';
import { ProjectRepoForm, type ProjectRepoFormProps } from '@/components/project/project-repo-form';
import type { ScriptType } from '@/components/project/startup-script-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAppHeader } from '@/frontend/components/app-header-context';
import { Logo } from '@/frontend/components/logo';
import { trpc } from '@/frontend/lib/trpc';

export default function NewProjectPage() {
  useAppHeader({ title: 'New Project' });

  const navigate = useNavigate();
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState('');
  const [startupScript, setStartupScript] = useState('');
  const [scriptType, setScriptType] = useState<ScriptType>('command');
  const [debouncedRepoPath, setDebouncedRepoPath] = useState('');

  const isElectron = Boolean(window.electronAPI?.isElectron);

  // Check for factory-factory.json
  const { data: factoryConfig } = trpc.project.checkFactoryConfig.useQuery(
    { repoPath: debouncedRepoPath },
    { enabled: debouncedRepoPath.length > 0 }
  );

  // Debounce repo path changes for API calls
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedRepoPath(repoPath);
    }, 500);

    return () => clearTimeout(timer);
  }, [repoPath]);

  const handleBrowse = async () => {
    if (!window.electronAPI?.showOpenDialog) {
      return;
    }

    try {
      const result = await window.electronAPI.showOpenDialog({
        title: 'Select Repository',
        properties: ['openDirectory', 'showHiddenFiles'],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        setRepoPath(result.filePaths[0] as string);
      }
    } catch {
      // Silently handle dialog failure - nothing actionable for user
    }
  };

  const { data: projects } = trpc.project.list.useQuery({ isArchived: false });
  const hasExistingProjects = projects && projects.length > 0;

  const utils = trpc.useUtils();

  const createProject = trpc.project.create.useMutation({
    onSuccess: (project) => {
      utils.project.list.invalidate();
      void navigate(`/projects/${project.slug}`);
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

    const trimmedScript = startupScript.trim();
    createProject.mutate({
      repoPath,
      startupScriptCommand: scriptType === 'command' && trimmedScript ? trimmedScript : undefined,
      startupScriptPath: scriptType === 'path' && trimmedScript ? trimmedScript : undefined,
    });
  };

  const handleImportSuccess = async () => {
    // Invalidate projects list and wait for refetch before navigating
    await utils.project.list.invalidate();
    await navigate('/projects');
  };

  const sharedFormProps = {
    error,
    repoPath,
    setRepoPath,
    isElectron,
    handleBrowse,
    factoryConfigExists: factoryConfig?.exists === true,
    scriptType,
    setScriptType,
    startupScript,
    setStartupScript,
    onSubmit: handleSubmit,
    isSubmitting: createProject.isPending,
    submitLabel: 'Add Project',
    submittingLabel: 'Adding...',
  } satisfies Omit<
    ProjectRepoFormProps,
    'helperText' | 'idPrefix' | 'footerActions' | 'submitFullWidth'
  >;

  // Onboarding view when no projects exist
  if (!hasExistingProjects) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center p-4 md:p-6">
        <div className="w-full max-w-lg space-y-8">
          <div className="flex flex-col items-center space-y-4">
            <Logo iconClassName="size-16" textClassName="text-2xl" className="flex-col gap-3" />
            <p className="text-muted-foreground">
              Autonomous software development orchestration system
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Get Started</CardTitle>
              <CardDescription>
                Add your first repository to begin using FactoryFactory.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ProjectRepoForm
                {...sharedFormProps}
                helperText="Path to a git repository on your local machine."
                idPrefix="onboard"
                submitFullWidth
              />

              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">Or</span>
                </div>
              </div>

              <DataImportButton
                onImportSuccess={handleImportSuccess}
                variant="outline"
                className="w-full"
              >
                Import from Backup
              </DataImportButton>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Normal view when projects already exist
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-3 md:p-6">
      <div className="flex items-center gap-2 md:gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/projects">
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
          <ProjectRepoForm
            {...sharedFormProps}
            helperText="Path to a git repository on your local machine. The project name will be derived from the directory name."
            idPrefix="new"
            footerActions={
              <Button variant="secondary" asChild>
                <Link to="/projects">Cancel</Link>
              </Button>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
