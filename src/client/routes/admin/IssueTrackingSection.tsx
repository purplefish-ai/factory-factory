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

type ConfigMode = 'view' | 'edit_key' | 'edit_team';

function ProjectIssueTrackingCard({
  projectId,
  projectName,
  currentProvider,
  linearTeamName,
  hasLinearApiKey,
}: {
  projectId: string;
  projectName: string;
  currentProvider: string;
  linearTeamName: string | null;
  hasLinearApiKey: boolean;
}) {
  const utils = trpc.useUtils();

  const [provider, setProvider] = useState(currentProvider);
  const [apiKey, setApiKey] = useState('');
  const [viewerName, setViewerName] = useState<string | null>(null);
  const [teams, setTeams] = useState<Array<{ id: string; name: string; key: string }>>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [configMode, setConfigMode] = useState<ConfigMode>('view');

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
      setConfigMode('view');
      setApiKey('');
      setViewerName(null);
      setTeams([]);
      setSelectedTeamId(null);
    },
    onError: (error) => toast.error(`Failed to save: ${error.message}`),
  });

  const handleProviderChange = (value: string) => {
    setProvider(value);
    if (value === 'GITHUB') {
      updateProject.mutate({ id: projectId, issueProvider: 'GITHUB' });
    } else if (value === 'LINEAR') {
      if (hasLinearApiKey) {
        // Already configured — stay in view mode
      } else {
        setConfigMode('edit_key');
      }
    }
  };

  const handleValidate = async () => {
    const result = await validateKey.mutateAsync({ apiKey });
    if (result.valid) {
      setViewerName(result.viewerName ?? null);
      setConfigMode('edit_team');
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
      issueProvider: 'LINEAR',
      linearApiKey: apiKey,
      linearTeamId: selectedTeam.id,
      linearTeamName: `${selectedTeam.name} (${selectedTeam.key})`,
    });
  };

  const handleReconfigure = () => {
    setApiKey('');
    setViewerName(null);
    setTeams([]);
    setSelectedTeamId(null);
    setConfigMode('edit_key');
  };

  const isLinear = provider === 'LINEAR';
  const isConfigured = isLinear && hasLinearApiKey && configMode === 'view';

  return (
    <div className="rounded-lg border bg-card">
      <div className="border-b bg-muted/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{projectName}</h3>
          {isConfigured && (
            <Badge variant="default" className="bg-green-600 hover:bg-green-700">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Linear
            </Badge>
          )}
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
                <SelectItem value="GITHUB">GitHub Issues</SelectItem>
                <SelectItem value="LINEAR">Linear Issues</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* API key input — same row as provider */}
          {isLinear && configMode === 'edit_key' && (
            <div className="flex items-end gap-2 flex-1 min-w-[250px]">
              <div className="space-y-1.5 flex-1">
                <Label htmlFor={`api-key-${projectId}`}>API Key</Label>
                <Input
                  id={`api-key-${projectId}`}
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="lin_api_..."
                  className="font-mono text-sm"
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

          {/* Connected label + team dropdown — same row as provider */}
          {isLinear && configMode === 'edit_team' && (
            <>
              {viewerName && (
                <div className="flex items-center gap-1.5 text-sm text-green-600 self-end pb-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  {viewerName}
                </div>
              )}
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

          {/* Configured view — same row as provider */}
          {isConfigured && linearTeamName && (
            <>
              <p className="text-sm text-muted-foreground self-end pb-2">Team: {linearTeamName}</p>
              <Button variant="outline" size="sm" onClick={handleReconfigure} className="self-end">
                Reconfigure
              </Button>
            </>
          )}
        </div>

        {/* Help text for API key */}
        {isLinear && configMode === 'edit_key' && (
          <p className="text-xs text-muted-foreground mt-2">
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
              hasLinearApiKey={!!project.linearApiKey}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
