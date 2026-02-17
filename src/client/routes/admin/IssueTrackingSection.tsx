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

function ProjectIssueTrackingCard({
  projectId,
  projectName,
  currentProvider,
  linearTeamName,
  linearViewerName,
  hasLinearApiKey,
}: {
  projectId: string;
  projectName: string;
  currentProvider: string;
  linearTeamName: string | null;
  linearViewerName: string | null;
  hasLinearApiKey: boolean;
}) {
  const utils = trpc.useUtils();

  const [provider, setProvider] = useState(currentProvider);
  const [apiKey, setApiKey] = useState('');
  const [viewerName, setViewerName] = useState<string | null>(linearViewerName);
  const [teams, setTeams] = useState<Array<{ id: string; name: string; key: string }>>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  const validateKey = trpc.linear.validateApiKey.useMutation({
    onError: (error) => toast.error(`Validation failed: ${error.message}`),
  });

  const fetchTeams = trpc.linear.listTeams.useMutation({
    onSuccess: (result) => setTeams(result),
    onError: (error) => toast.error(`Failed to load teams: ${error.message}`),
  });

  const updateProject = trpc.project.update.useMutation({
    onSuccess: () => {
      toast.success('Issue tracking settings saved');
      utils.project.list.invalidate();
      setApiKey('');
      setTeams([]);
      setSelectedTeamId(null);
    },
    onError: (error) => toast.error(`Failed to save: ${error.message}`),
  });

  const handleProviderChange = (value: string) => {
    setProvider(value);
    updateProject.mutate({ id: projectId, issueProvider: value as IssueProvider });
  };

  const handleValidate = async () => {
    const result = await validateKey.mutateAsync({ apiKey });
    if (result.valid) {
      setViewerName(result.viewerName ?? null);
      fetchTeams.mutate({ apiKey });
    } else {
      toast.error(`Validation failed: ${result.error ?? 'Unknown error'}`);
    }
  };

  const handleSave = () => {
    const selectedTeam = teams.find((t) => t.id === selectedTeamId);
    if (!selectedTeam) {
      return;
    }

    updateProject.mutate({
      id: projectId,
      issueProvider: IssueProvider.LINEAR,
      linearApiKey: apiKey,
      linearTeamId: selectedTeam.id,
      linearTeamName: `${selectedTeam.name} (${selectedTeam.key})`,
      linearViewerName: viewerName,
    });
  };

  const isLinear = provider === IssueProvider.LINEAR;
  const isValidated = viewerName !== null;
  const hasTeamChoices = teams.length > 0;
  const showStoredTeam = isLinear && linearTeamName && !hasTeamChoices;

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b bg-muted/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{projectName}</h3>
          <Badge variant="default" className="bg-green-600 hover:bg-green-700">
            <CheckCircle2 className="w-3 h-3 mr-1" />
            {isLinear ? 'Linear' : 'GitHub'}
          </Badge>
        </div>
      </div>

      <div className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* Issue Provider dropdown */}
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

          {/* API key — always visible when Linear */}
          {isLinear && (
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
                  placeholder={hasLinearApiKey ? '••••••••••••••••••••' : 'lin_api_...'}
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
          )}

          {/* Team dropdown — after validation */}
          {isLinear && isValidated && hasTeamChoices && (
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
              <Button
                onClick={handleSave}
                disabled={!selectedTeamId || updateProject.isPending}
                className="self-end"
              >
                {updateProject.isPending ? 'Saving...' : 'Save'}
              </Button>
            </>
          )}

          {/* Current team name — when configured but not re-validating */}
          {showStoredTeam && (
            <p className="text-sm text-muted-foreground self-end pb-2">Team: {linearTeamName}</p>
          )}
        </div>

        {/* Help text for API key */}
        {isLinear && !isValidated && (
          <p className="text-xs text-muted-foreground mt-2">
            Create a personal API key at{' '}
            <a
              href="https://linear.app/purplefish/settings/account/security"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              linear.app/settings/account/security
            </a>
          </p>
        )}
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
    linearTeamName: string | null;
    linearViewerName: string | null;
    linearApiKey: string | null;
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
              linearTeamName={project.linearTeamName}
              linearViewerName={project.linearViewerName}
              hasLinearApiKey={!!project.linearApiKey}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
