import { CheckCircle2, Link2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { trpc } from '@/frontend/lib/trpc';
import { IssueProvider } from '@/shared/core/enums';
import type {
  IssueTrackerConfig,
  PublicIssueTrackerConfig,
  PublicLinearConfig,
} from '@/shared/schemas/issue-tracker-config.schema';

function LinearConfigFields({
  projectId,
  linearConfig,
  onSave,
  isSaving,
}: {
  projectId: string;
  linearConfig: PublicLinearConfig | null;
  onSave: (config: IssueTrackerConfig) => void;
  isSaving: boolean;
}) {
  const [apiKey, setApiKey] = useState('');
  const [viewerName, setViewerName] = useState<string | null>(linearConfig?.viewerName ?? null);
  const [teams, setTeams] = useState<Array<{ id: string; name: string; key: string }>>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  const validateKey = trpc.linear.validateApiKey.useMutation({
    onError: (error) => toast.error(`Validation failed: ${error.message}`),
  });

  const fetchTeams = trpc.linear.listTeams.useMutation({
    onSuccess: (result) => setTeams(result),
    onError: (error) => toast.error(`Failed to load teams: ${error.message}`),
  });

  const handleValidate = async () => {
    try {
      const result = await validateKey.mutateAsync({ apiKey });
      if (result.valid) {
        setViewerName(result.viewerName ?? null);
        fetchTeams.mutate({ apiKey });
      } else {
        toast.error(`Validation failed: ${result.error ?? 'Unknown error'}`);
      }
    } catch {
      // Transport errors already surfaced by onError callback
    }
  };

  const handleSave = () => {
    const selectedTeam = teams.find((t) => t.id === selectedTeamId);
    if (!(selectedTeam && viewerName)) {
      return;
    }
    onSave({
      linear: {
        apiKey,
        teamId: selectedTeam.id,
        teamName: `${selectedTeam.name} (${selectedTeam.key})`,
        viewerName,
      },
    });
    setApiKey('');
    setTeams([]);
    setSelectedTeamId(null);
  };

  const isValidated = viewerName !== null;
  const hasTeamChoices = teams.length > 0;
  const hasStoredKey = linearConfig?.hasApiKey ?? false;
  const storedTeamName = linearConfig?.teamName ?? null;

  return (
    <>
      <div className="flex items-end gap-2">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor={`api-key-${projectId}`}>API Key</Label>
            {isValidated && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle2 className="w-3 h-3" />
                Connected as {viewerName}
              </span>
            )}
          </div>
          <Input
            id={`api-key-${projectId}`}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasStoredKey ? '••••••••••••••••••••' : 'lin_api_...'}
            className="font-mono text-sm w-[280px]"
          />
        </div>
        <Button
          variant="outline"
          onClick={handleValidate}
          disabled={validateKey.isPending || !apiKey}
        >
          {validateKey.isPending ? 'Validating...' : 'Validate'}
        </Button>
      </div>

      {isValidated && hasTeamChoices && (
        <>
          <div className="space-y-1.5">
            <Label>Team</Label>
            {fetchTeams.isPending ? (
              <p className="text-sm text-muted-foreground py-2">Loading...</p>
            ) : (
              <Select value={selectedTeamId ?? ''} onValueChange={setSelectedTeamId}>
                <SelectTrigger className="w-[220px]">
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
            )}
          </div>
          <Button onClick={handleSave} disabled={!selectedTeamId || isSaving} className="self-end">
            {isSaving ? 'Saving...' : 'Save'}
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

function ProjectIssueTrackingCard({
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
  const [provider, setProvider] = useState(currentProvider);

  const updateProject = trpc.project.update.useMutation({
    onSuccess: () => {
      toast.success('Issue tracking settings saved');
      utils.project.list.invalidate();
    },
    onError: (error) => toast.error(`Failed to save: ${error.message}`),
  });

  const handleProviderChange = (value: string) => {
    setProvider(value);
    updateProject.mutate({ id: projectId, issueProvider: value as IssueProvider });
  };

  const handleLinearSave = (config: IssueTrackerConfig) => {
    updateProject.mutate({
      id: projectId,
      issueProvider: IssueProvider.LINEAR,
      issueTrackerConfig: config,
    });
  };

  const isLinear = provider === IssueProvider.LINEAR;
  const isConfigured = !isLinear || issueTrackerConfig?.linear != null;

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b bg-muted/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{projectName}</h3>
          {isConfigured && (
            <Badge variant="default" className="bg-green-600 hover:bg-green-700">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              {isLinear ? 'Linear' : 'GitHub'}
            </Badge>
          )}
        </div>
      </div>

      <div className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label>Issue Provider</Label>
            <Select
              value={provider}
              onValueChange={handleProviderChange}
              disabled={updateProject.isPending}
            >
              <SelectTrigger className="w-[180px]">
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
      </div>
    </div>
  );
}

export function IssueTrackingSection({
  projects,
}: {
  projects: Array<{
    id: string;
    name: string;
    issueProvider: string;
    issueTrackerConfig: PublicIssueTrackerConfig | null;
  }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="w-5 h-5" />
          Issue Tracking
        </CardTitle>
        <CardDescription>
          Configure the issue provider for each project (GitHub Issues or Linear)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects found.</p>
        ) : (
          projects.map((project) => (
            <ProjectIssueTrackingCard
              key={project.id}
              projectId={project.id}
              projectName={project.name}
              currentProvider={project.issueProvider}
              issueTrackerConfig={project.issueTrackerConfig}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
