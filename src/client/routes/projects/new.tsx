import { ArrowLeftIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { DataImportButton } from '@/components/data-import/data-import-button';
import { GithubUrlForm } from '@/components/project/github-url-form';
import { OnboardingCliHealth } from '@/components/project/onboarding-cli-health';
import { ProjectRepoForm, type ProjectRepoFormProps } from '@/components/project/project-repo-form';
import { SetupTerminalModal } from '@/components/project/setup-terminal-modal';
import type { ScriptType } from '@/components/project/startup-script-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppHeader } from '@/frontend/components/app-header-context';
import { Logo } from '@/frontend/components/logo';
import { trpc } from '@/frontend/lib/trpc';

type ProjectSource = 'local' | 'github';

function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) {
    return null;
  }
  return { owner: match[1] as string, repo: match[2] as string };
}

export default function NewProjectPage() {
  useAppHeader({ title: 'New Project' });

  const navigate = useNavigate();
  const [source, setSource] = useState<ProjectSource>('local');

  // Local path state
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState('');
  const [startupScript, setStartupScript] = useState('');
  const [scriptType, setScriptType] = useState<ScriptType>('command');
  const [debouncedRepoPath, setDebouncedRepoPath] = useState('');

  // GitHub URL state
  const [githubUrl, setGithubUrl] = useState('');
  const [githubError, setGithubError] = useState('');
  const [githubStartupScript, setGithubStartupScript] = useState('');
  const [githubScriptType, setGithubScriptType] = useState<ScriptType>('command');
  const [terminalOpen, setTerminalOpen] = useState(false);

  const isElectron = Boolean(window.electronAPI?.isElectron);

  const parsedRepo = useMemo(() => {
    const trimmed = githubUrl.trim();
    if (!trimmed) {
      return null;
    }
    return parseGithubUrl(trimmed);
  }, [githubUrl]);

  // Check for factory-factory.json (local path)
  const { data: factoryConfig } = trpc.project.checkFactoryConfig.useQuery(
    { repoPath: debouncedRepoPath },
    { enabled: debouncedRepoPath.length > 0 }
  );

  // Check GitHub auth status
  const {
    data: authStatus,
    isLoading: isCheckingAuth,
    refetch: refetchAuth,
  } = trpc.project.checkGithubAuth.useQuery(undefined, {
    enabled: source === 'github',
  });

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
      // Silently handle dialog failure
    }
  };

  const { data: projects } = trpc.project.list.useQuery({ isArchived: false });
  const hasExistingProjects = projects && projects.length > 0;

  const utils = trpc.useUtils();

  // Local path creation
  const createProject = trpc.project.create.useMutation({
    onSuccess: (project) => {
      utils.project.list.invalidate();
      void navigate(`/projects/${project.slug}`);
    },
    onError: (err) => setError(err.message),
  });

  // GitHub URL creation
  const createFromGithub = trpc.project.createFromGithub.useMutation({
    onSuccess: (project) => {
      utils.project.list.invalidate();
      void navigate(`/projects/${project.slug}`);
    },
    onError: (err) => setGithubError(err.message),
  });

  const handleLocalSubmit = (e: React.FormEvent) => {
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

  const handleGithubSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setGithubError('');
    if (!githubUrl.trim()) {
      setGithubError('GitHub URL is required');
      return;
    }
    if (!parsedRepo) {
      setGithubError('Invalid GitHub URL. Expected format: https://github.com/owner/repo');
      return;
    }
    const trimmedScript = githubStartupScript.trim();
    createFromGithub.mutate({
      githubUrl: githubUrl.trim(),
      startupScriptCommand:
        githubScriptType === 'command' && trimmedScript ? trimmedScript : undefined,
      startupScriptPath: githubScriptType === 'path' && trimmedScript ? trimmedScript : undefined,
    });
  };

  const handleImportSuccess = async () => {
    await utils.project.list.invalidate();
    await navigate('/projects');
  };

  const handleTerminalClose = useCallback(() => {
    setTerminalOpen(false);
    // Re-check auth after terminal closes
    refetchAuth();
    utils.admin.checkCLIHealth.invalidate();
  }, [refetchAuth, utils.admin.checkCLIHealth]);

  const localFormProps = {
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
    onSubmit: handleLocalSubmit,
    isSubmitting: createProject.isPending,
    submitLabel: 'Add Project',
    submittingLabel: 'Adding...',
  } satisfies Omit<
    ProjectRepoFormProps,
    'helperText' | 'idPrefix' | 'footerActions' | 'submitFullWidth'
  >;

  const githubFormProps = {
    error: githubError,
    githubUrl,
    setGithubUrl,
    parsedRepo,
    authStatus,
    isCheckingAuth,
    onOpenTerminal: () => setTerminalOpen(true),
    scriptType: githubScriptType,
    setScriptType: setGithubScriptType,
    startupScript: githubStartupScript,
    setStartupScript: setGithubStartupScript,
    onSubmit: handleGithubSubmit,
    isSubmitting: createFromGithub.isPending,
    submitLabel: 'Clone & Add Project',
    submittingLabel: 'Cloning...',
  };

  const sourceSelector = (
    <Tabs value={source} onValueChange={(v) => setSource(v as ProjectSource)}>
      <TabsList className="w-full">
        <TabsTrigger value="local" className="flex-1">
          Local Path
        </TabsTrigger>
        <TabsTrigger value="github" className="flex-1">
          GitHub URL
        </TabsTrigger>
      </TabsList>
      <TabsContent value="local">
        <ProjectRepoForm
          {...localFormProps}
          helperText="Path to a git repository on your local machine."
          idPrefix="onboard"
          submitFullWidth
        />
      </TabsContent>
      <TabsContent value="github">
        <GithubUrlForm {...githubFormProps} idPrefix="onboard-gh" submitFullWidth />
      </TabsContent>
    </Tabs>
  );

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
              <OnboardingCliHealth onOpenTerminal={() => setTerminalOpen(true)} />

              <div className="my-4 border-t" />

              {sourceSelector}

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

        <SetupTerminalModal open={terminalOpen} onClose={handleTerminalClose} />
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
          <CardDescription>Provide a local path or clone from GitHub.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={source} onValueChange={(v) => setSource(v as ProjectSource)}>
            <TabsList className="w-full">
              <TabsTrigger value="local" className="flex-1">
                Local Path
              </TabsTrigger>
              <TabsTrigger value="github" className="flex-1">
                GitHub URL
              </TabsTrigger>
            </TabsList>
            <TabsContent value="local">
              <ProjectRepoForm
                {...localFormProps}
                helperText="Path to a git repository on your local machine. The project name will be derived from the directory name."
                idPrefix="new"
                footerActions={
                  <Button variant="secondary" asChild>
                    <Link to="/projects">Cancel</Link>
                  </Button>
                }
              />
            </TabsContent>
            <TabsContent value="github">
              <GithubUrlForm
                {...githubFormProps}
                idPrefix="new-gh"
                footerActions={
                  <Button variant="secondary" asChild>
                    <Link to="/projects">Cancel</Link>
                  </Button>
                }
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <SetupTerminalModal open={terminalOpen} onClose={handleTerminalClose} />
    </div>
  );
}
