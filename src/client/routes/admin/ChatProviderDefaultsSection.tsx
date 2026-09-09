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

export function ChatProviderDefaultsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const { data: providerOptions } = trpc.userSettings.getProviderOptions.useQuery(undefined, {
    staleTime: 30_000,
  });
  const utils = trpc.useUtils();
  const [localClaudeModel, setLocalClaudeModel] = useState('sonnet');
  const [localCodexModel, setLocalCodexModel] = useState('default');
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('Chat defaults updated');
      utils.userSettings.get.invalidate();
    },
    onError: (error, variables) => {
      const savedSettings = utils.userSettings.get.getData() ?? settings;
      if (variables.defaultClaudeModel !== undefined) {
        setLocalClaudeModel((model) =>
          model === variables.defaultClaudeModel
            ? (savedSettings?.defaultClaudeModel ?? 'sonnet')
            : model
        );
      }
      if (variables.defaultCodexModel !== undefined) {
        setLocalCodexModel((model) =>
          model === variables.defaultCodexModel
            ? (savedSettings?.defaultCodexModel ?? 'default')
            : model
        );
      }
      toast.error(`Failed to update chat defaults: ${error.message}`);
    },
  });

  useEffect(() => {
    setLocalClaudeModel(settings?.defaultClaudeModel ?? 'sonnet');
    setLocalCodexModel(settings?.defaultCodexModel ?? 'default');
  }, [settings?.defaultClaudeModel, settings?.defaultCodexModel]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chat Defaults</CardTitle>
          <CardDescription>Default provider for new chats</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const currentProvider = settings?.defaultSessionProvider ?? 'CLAUDE';
  const currentClaudeModel = settings?.defaultClaudeModel ?? 'sonnet';
  const currentCodexModel = settings?.defaultCodexModel ?? 'default';
  const currentClaudeReasoningEffort = settings?.defaultClaudeReasoningEffort ?? null;
  const currentCodexReasoningEffort = settings?.defaultCodexReasoningEffort ?? null;
  const currentWorkspacePermissions = settings?.defaultWorkspacePermissions ?? 'STRICT';
  const providerDefaultValue = '__provider_default__';
  const getModelOptions = (provider: 'CLAUDE' | 'CODEX', currentValue: string) => {
    const options = providerOptions?.[provider]?.models ?? [];
    if (options.some((option) => option.value === currentValue)) {
      return options;
    }
    const savedModelLabel =
      provider === 'CLAUDE'
        ? `Saved model — ${currentValue} (not in current catalog)`
        : currentValue;
    return [{ value: currentValue, label: savedModelLabel }, ...options];
  };
  const getEffortOptions = (provider: 'CLAUDE' | 'CODEX', currentValue: string | null) => {
    const options = providerOptions?.[provider]?.efforts ?? [];
    if (!currentValue || options.some((option) => option.value === currentValue)) {
      return options;
    }
    return [{ value: currentValue, label: currentValue }, ...options];
  };
  const modelSettingsByProvider = {
    CLAUDE: {
      fallbackValue: 'sonnet',
      currentValue: currentClaudeModel,
      localValue: localClaudeModel,
      setLocalValue: setLocalClaudeModel,
      buildPayload: (model: string) => ({ defaultClaudeModel: model }),
      buildEffortPayload: (effort: string | null) => ({ defaultClaudeReasoningEffort: effort }),
    },
    CODEX: {
      fallbackValue: 'default',
      currentValue: currentCodexModel,
      localValue: localCodexModel,
      setLocalValue: setLocalCodexModel,
      buildPayload: (model: string) => ({ defaultCodexModel: model }),
      buildEffortPayload: (effort: string | null) => ({ defaultCodexReasoningEffort: effort }),
    },
  } as const;

  const saveDefaultModel = (provider: 'CLAUDE' | 'CODEX', value: string) => {
    const providerSettings = modelSettingsByProvider[provider];
    const normalizedValue = value.trim() || providerSettings.fallbackValue;

    if (normalizedValue === providerSettings.currentValue) {
      if (providerSettings.localValue !== providerSettings.currentValue) {
        providerSettings.setLocalValue(providerSettings.currentValue);
      }
      return;
    }

    updateSettings.mutate(providerSettings.buildPayload(normalizedValue));
  };

  const saveDefaultEffort = (provider: 'CLAUDE' | 'CODEX', value: string) => {
    const effort = value === providerDefaultValue ? null : value;
    updateSettings.mutate(modelSettingsByProvider[provider].buildEffortPayload(effort));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat Defaults</CardTitle>
        <CardDescription>
          Default provider used when a workspace defers provider selection
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Label htmlFor="chat-default-provider">Default chat provider</Label>
        <Select
          value={currentProvider}
          onValueChange={(value) => {
            if (value === 'CLAUDE' || value === 'CODEX') {
              updateSettings.mutate({ defaultSessionProvider: value });
            }
          }}
          disabled={updateSettings.isPending}
        >
          <SelectTrigger id="chat-default-provider">
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
            <Label htmlFor="default-claude-model">Default Claude model</Label>
            <Select
              value={localClaudeModel}
              onValueChange={(value) => {
                setLocalClaudeModel(value);
                saveDefaultModel('CLAUDE', value);
              }}
              disabled={updateSettings.isPending}
            >
              <SelectTrigger id="default-claude-model">
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
            <p className="text-xs text-muted-foreground">
              Claude aliases like <code className="rounded bg-muted px-1">sonnet</code> and{' '}
              <code className="rounded bg-muted px-1">opus</code> are supported.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="default-codex-model">Default Codex model</Label>
            <Select
              value={localCodexModel}
              onValueChange={(value) => {
                setLocalCodexModel(value);
                saveDefaultModel('CODEX', value);
              }}
              disabled={updateSettings.isPending}
            >
              <SelectTrigger id="default-codex-model">
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
            <p className="text-xs text-muted-foreground">
              Codex options are loaded from the CLI when available.
            </p>
          </div>
        </div>
        <div className="grid gap-3 pt-1 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="default-claude-effort">Default Claude effort</Label>
            <Select
              value={currentClaudeReasoningEffort ?? providerDefaultValue}
              onValueChange={(value) => saveDefaultEffort('CLAUDE', value)}
              disabled={updateSettings.isPending}
            >
              <SelectTrigger id="default-claude-effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={providerDefaultValue}>Provider default</SelectItem>
                {getEffortOptions('CLAUDE', currentClaudeReasoningEffort).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="default-codex-effort">Default Codex effort</Label>
            <Select
              value={currentCodexReasoningEffort ?? providerDefaultValue}
              onValueChange={(value) => saveDefaultEffort('CODEX', value)}
              disabled={updateSettings.isPending}
            >
              <SelectTrigger id="default-codex-effort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={providerDefaultValue}>Provider default</SelectItem>
                {getEffortOptions('CODEX', currentCodexReasoningEffort).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2 pt-1">
          <Label htmlFor="workspace-permissions">Default permissions for new workspaces</Label>
          <Select
            value={currentWorkspacePermissions}
            onValueChange={(value) => {
              if (value === 'STRICT' || value === 'RELAXED' || value === 'YOLO') {
                updateSettings.mutate({ defaultWorkspacePermissions: value });
              }
            }}
            disabled={updateSettings.isPending}
          >
            <SelectTrigger id="workspace-permissions">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="STRICT">Strict</SelectItem>
              <SelectItem value="RELAXED">Relaxed</SelectItem>
              <SelectItem value="YOLO">YOLO</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
