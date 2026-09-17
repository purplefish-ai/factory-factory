import { ShieldWarningIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ProviderCliWarning } from '@/client/components/provider-cli-warning';
import { trpc } from '@/client/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

export function AdversarialReviewSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const { data: providerOptions } = trpc.userSettings.getProviderOptions.useQuery(undefined, {
    staleTime: 30_000,
  });
  const utils = trpc.useUtils();
  const [localClaudeModel, setLocalClaudeModel] = useState('sonnet');
  const [localCodexModel, setLocalCodexModel] = useState('default');
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('Adversarial review settings updated');
      utils.userSettings.get.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update adversarial review settings: ${error.message}`);
    },
  });

  useEffect(() => {
    setLocalClaudeModel(settings?.reviewerClaudeModel ?? 'sonnet');
    setLocalCodexModel(settings?.reviewerCodexModel ?? 'default');
  }, [settings?.reviewerClaudeModel, settings?.reviewerCodexModel]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Adversarial Review</CardTitle>
          <CardDescription>Reviewer provider for the open PR</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const currentProvider = settings?.reviewerSessionProvider ?? 'CODEX';
  const currentClaudeModel = settings?.reviewerClaudeModel ?? 'sonnet';
  const currentCodexModel = settings?.reviewerCodexModel ?? 'default';
  const postReviewToGitHub = settings?.postReviewToGitHub ?? true;

  const getModelOptions = (provider: 'CLAUDE' | 'CODEX', currentValue: string) => {
    const options = providerOptions?.[provider]?.models ?? [];
    if (options.some((option) => option.value === currentValue)) {
      return options;
    }
    return [{ value: currentValue, label: currentValue }, ...options];
  };

  const saveModel = (provider: 'CLAUDE' | 'CODEX', value: string) => {
    if (provider === 'CLAUDE') {
      setLocalClaudeModel(value);
      updateSettings.mutate({ reviewerClaudeModel: value });
    } else {
      setLocalCodexModel(value);
      updateSettings.mutate({ reviewerCodexModel: value });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldWarningIcon className="w-5 h-5" />
          Adversarial Review
        </CardTitle>
        <CardDescription>
          Review an open PR with a different provider/model than the one that built it — e.g. build
          with Claude, review with Codex.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="reviewer-provider">Reviewer provider</Label>
        <Select
          value={currentProvider}
          onValueChange={(value) => {
            if (value === 'CLAUDE' || value === 'CODEX') {
              updateSettings.mutate({ reviewerSessionProvider: value });
            }
          }}
          disabled={updateSettings.isPending}
        >
          <SelectTrigger id="reviewer-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="CLAUDE">Claude</SelectItem>
            <SelectItem value="CODEX">Codex</SelectItem>
          </SelectContent>
        </Select>
        <ProviderCliWarning provider={currentProvider} />

        <div className="grid gap-3 pt-1 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="reviewer-claude-model">Claude reviewer model</Label>
            <Select
              value={localClaudeModel}
              onValueChange={(value) => saveModel('CLAUDE', value)}
              disabled={updateSettings.isPending}
            >
              <SelectTrigger id="reviewer-claude-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getModelOptions('CLAUDE', currentClaudeModel).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reviewer-codex-model">Codex reviewer model</Label>
            <Select
              value={localCodexModel}
              onValueChange={(value) => saveModel('CODEX', value)}
              disabled={updateSettings.isPending}
            >
              <SelectTrigger id="reviewer-codex-model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getModelOptions('CODEX', currentCodexModel).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="post-review-to-github">Post reviews to GitHub</Label>
            <p className="text-sm text-muted-foreground">
              Post the review as a summary plus inline comments on the PR. Off runs the review
              in-app only.
            </p>
          </div>
          <Switch
            id="post-review-to-github"
            checked={postReviewToGitHub}
            onCheckedChange={(checked) => {
              updateSettings.mutate({ postReviewToGitHub: checked });
            }}
            disabled={updateSettings.isPending}
          />
        </div>
      </CardContent>
    </Card>
  );
}
