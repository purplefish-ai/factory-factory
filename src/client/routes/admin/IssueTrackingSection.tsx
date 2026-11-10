import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { LinkIcon } from '@phosphor-icons/react/dist/csr/Link';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { StatusChip } from '@/client/components/status-indicators';
import { runInBackground } from '@/client/lib/background-task';
import { invalidateProject } from '@/client/lib/project-cache';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { IssueProvider } from '@/shared/core/enums';
import type {
  IssueTrackerConfig,
  PublicIssueTrackerConfig,
  PublicLinearConfig,
} from '@/shared/schemas/issue-tracker-config.schema';
import { SETTING_FIELD_WIDTH, SettingsSection } from './settings-section';

function LinearConfigFields({
  projectId,
  linearConfig,
  onSave,
  isSaving,
}: {
  projectId: string;
  linearConfig: PublicLinearConfig | null;
  onSave: (config: IssueTrackerConfig) => Promise<void>;
  isSaving: boolean;
}) {
  const [apiKey, setApiKey] = useState('');
  const [viewerName, setViewerName] = useState<string | null>(linearConfig?.viewerName ?? null);
  const [teams, setTeams] = useState<Array<{ id: string; name: string; key: string }>>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const formGeneration = useRef(0);

  const validateAndList = trpc.linear.validateKeyAndListTeams.useMutation({
    meta: { errorToast: false },
  });

  const resetValidation = () => {
    formGeneration.current += 1;
    setViewerName(null);
    setTeams([]);
    setSelectedTeamId(null);
  };

  const handleApiKeyChange = (value: string) => {
    setApiKey(value);
    resetValidation();
  };

  const handleValidate = async () => {
    resetValidation();
    const generation = formGeneration.current;
    try {
      const result = await validateAndList.mutateAsync({ apiKey });
      // Key edits and newer validations supersede this response, even if the key changes back.
      if (generation !== formGeneration.current) {
        return;
      }
      if (result.valid) {
        setViewerName(result.viewerName ?? null);
        setTeams(result.teams ?? []);
      } else {
        toast.error(
          `Couldn't validate issue tracking credentials. ${result.error ?? 'Unknown error'}`
        );
      }
    } catch (error) {
      if (generation === formGeneration.current) {
        toast.error(
          `Couldn't validate issue tracking credentials. ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  };

  const handleSave = async () => {
    const selectedTeam = teams.find((t) => t.id === selectedTeamId);
    if (!(selectedTeam && viewerName)) {
      return;
    }
    const generation = ++formGeneration.current;
    try {
      await onSave({
        linear: {
          apiKey,
          teamId: selectedTeam.id,
          teamName: `${selectedTeam.name} (${selectedTeam.key})`,
          viewerName,
        },
      });
      // A completed save must not clear edits or validation started since submission.
      if (generation === formGeneration.current) {
        handleApiKeyChange('');
      }
    } catch {
      // The mutation reports the error; retain the validated form for retry.
    }
  };

  const isValidated = viewerName !== null;
  const hasTeamChoices = teams.length > 0;
  const hasStoredKey = linearConfig?.hasApiKey ?? false;
  const storedTeamName = linearConfig?.teamName ?? null;

  return (
    <>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor={`api-key-${projectId}`}>API key</Label>
            {isValidated && (
              <span className="flex items-center gap-1 text-xs text-success">
                <CheckCircleIcon className="w-3 h-3" />
                Connected as {viewerName}
              </span>
            )}
          </div>
          <Input
            id={`api-key-${projectId}`}
            type="password"
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            placeholder={hasStoredKey ? '••••••••••••••••••••' : 'lin_api_...'}
            className={`font-mono text-sm ${SETTING_FIELD_WIDTH}`}
          />
        </div>
        <Button
          variant="outline"
          onClick={() => {
            runInBackground(handleValidate(), "Couldn't update issue tracking.");
          }}
          pending={validateAndList.isPending}
          pendingLabel="Validating…"
          disabled={!apiKey}
        >
          Validate
        </Button>
      </div>

      {isValidated && hasTeamChoices && (
        <>
          <div className="min-w-0 space-y-1.5">
            <Label>Team</Label>
            <Select
              value={selectedTeamId ?? ''}
              onValueChange={(value) => {
                formGeneration.current += 1;
                setSelectedTeamId(value);
              }}
            >
              <SelectTrigger className="w-full sm:w-[220px]">
                <SelectValue placeholder="Select a team" />
              </SelectTrigger>
              <SelectContent>
                {teams.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name} ({team.key})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => {
              runInBackground(handleSave(), "Couldn't update issue tracking.");
            }}
            pending={isSaving}
            pendingLabel="Saving…"
            disabled={!selectedTeamId}
            className="self-end"
          >
            Save
          </Button>
        </>
      )}

      {storedTeamName && !hasTeamChoices && (
        <p className="text-sm text-muted-foreground self-end pb-2">Team: {storedTeamName}</p>
      )}

      {!isValidated && (
        <p className="text-xs text-muted-foreground mt-2 basis-full">
          Create a personal API key at{' '}
          <a
            href="https://linear.app/settings/api"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            linear.app/settings/api
          </a>
        </p>
      )}
    </>
  );
}

export function ProjectIssueTrackingCard({
  projectId,
  projectName,
  currentProvider,
  issueTrackerConfig,
}: {
  projectId: string;
  projectName: string;
  currentProvider: string;
  issueTrackerConfig: PublicIssueTrackerConfig | null;
}) {
  const utils = trpc.useUtils();
  const [optimisticProvider, setOptimisticProvider] = useState<string | null>(null);
  const providerGeneration = useRef(0);
  const pendingProviderSaves = useRef(0);
  const provider = optimisticProvider ?? currentProvider;
  const updateProvider = trpc.project.update.useMutation({ meta: { errorToast: false } });

  const updateProject = trpc.project.update.useMutation({
    onSuccess: () => {
      toast.success('Issue tracking settings saved');
      runInBackground(invalidateProject(utils, projectId));
    },
    onError: (error) => toast.error(`Couldn't save issue tracking settings. ${error.message}`),
  });

  const resyncProvider = async () => {
    // Refetch after every outstanding write settles, including an older request finishing last.
    if (pendingProviderSaves.current !== 0) {
      return;
    }
    const generation = providerGeneration.current;
    await invalidateProject(utils, projectId);
    // A new choice made during the refetch still owns the optimistic display.
    if (generation === providerGeneration.current && pendingProviderSaves.current === 0) {
      setOptimisticProvider(null);
    }
  };

  const handleProviderChange = async (value: string) => {
    const generation = ++providerGeneration.current;
    pendingProviderSaves.current += 1;
    setOptimisticProvider(value);
    try {
      const saved = await updateProvider.mutateAsync({
        id: projectId,
        issueProvider: value as IssueProvider,
      });
      // Keep the last confirmed provider even if the following refetch fails.
      utils.project.list.setQueriesData(undefined, {}, (projects) =>
        projects?.map((project) =>
          project.id === saved.id ? { ...project, issueProvider: saved.issueProvider } : project
        )
      );
    } catch (error) {
      if (generation === providerGeneration.current) {
        setOptimisticProvider(null);
        toast.error(
          `Couldn't save issue tracking settings. ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    } finally {
      pendingProviderSaves.current -= 1;
      await resyncProvider();
    }
  };

  const handleLinearSave = async (config: IssueTrackerConfig) => {
    await updateProject.mutateAsync({
      id: projectId,
      issueProvider: IssueProvider.LINEAR,
      issueTrackerConfig: config,
    });
  };

  const isLinear = provider === IssueProvider.LINEAR;
  const isConfigured = !isLinear || issueTrackerConfig?.linear != null;

  return (
    <SettingsSection
      title="Issue tracking"
      icon={<LinkIcon className="h-5 w-5" />}
      description={
        <span className="[overflow-wrap:anywhere]">
          Configure GitHub Issues or Linear for {projectName}
        </span>
      }
    >
      <div className="flex items-center gap-2">
        {isConfigured && (
          <StatusChip tone="success" icon={CheckCircleIcon} size="md">
            {isLinear ? 'Linear' : 'GitHub'}
          </StatusChip>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`issue-provider-${projectId}`}>Issue provider</Label>
          <Select
            value={provider}
            onValueChange={(value) => {
              runInBackground(handleProviderChange(value), "Couldn't update issue tracking.");
            }}
            disabled={updateProvider.isPending || updateProject.isPending}
          >
            <SelectTrigger id={`issue-provider-${projectId}`} className="w-full sm:w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={IssueProvider.GITHUB}>GitHub Issues</SelectItem>
              <SelectItem value={IssueProvider.LINEAR}>Linear Issues</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLinear && (
          <LinearConfigFields
            projectId={projectId}
            linearConfig={issueTrackerConfig?.linear ?? null}
            onSave={handleLinearSave}
            isSaving={updateProject.isPending}
          />
        )}
      </div>
    </SettingsSection>
  );
}
