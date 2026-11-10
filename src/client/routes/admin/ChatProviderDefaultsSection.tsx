import { ProviderCliWarning } from '@/client/components/provider-cli-warning';
import {
  useProviderOptions,
  useUpdateUserSettings,
  useUserSettings,
} from '@/client/lib/user-settings-queries';
import { NATIVE_PERMISSION_DESCRIPTION, NATIVE_PERMISSION_OPTIONS } from './native-permission-copy';
import {
  effortOptions,
  PROVIDER_DEFAULT_EFFORT,
  PROVIDER_OPTIONS,
  toEffort,
  withSavedOption,
} from './provider-model-options';
import { SettingSelect, SettingsSection } from './settings-section';

export function ChatProviderDefaultsSection() {
  const settingsQuery = useUserSettings();
  const { data: providerOptions } = useProviderOptions();
  const updateSettings = useUpdateUserSettings();

  return (
    <SettingsSection
      title="Chat defaults"
      description="Default provider used when a workspace defers provider selection"
      query={settingsQuery}
      errorTitle="Couldn't load chat defaults"
    >
      {(settings) => (
        <>
          <div className="space-y-3">
            <SettingSelect
              id="chat-default-provider"
              label="Default chat provider"
              saving={updateSettings.isSaving('defaultSessionProvider')}
              value={settings.defaultSessionProvider}
              options={PROVIDER_OPTIONS}
              onValueChange={(value) => updateSettings.mutate({ defaultSessionProvider: value })}
            />
            <ProviderCliWarning provider={settings.defaultSessionProvider} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingSelect
              id="default-claude-model"
              label="Default Claude model"
              description={
                <>
                  Claude aliases like <code className="rounded bg-muted px-1">sonnet</code> and{' '}
                  <code className="rounded bg-muted px-1">opus</code> are supported.
                </>
              }
              saving={updateSettings.isSaving('defaultClaudeModel')}
              value={settings.defaultClaudeModel}
              options={withSavedOption(
                providerOptions?.CLAUDE.models,
                settings.defaultClaudeModel,
                `Saved model — ${settings.defaultClaudeModel} (not in current catalog)`
              )}
              onValueChange={(value) => updateSettings.mutate({ defaultClaudeModel: value })}
            />
            <SettingSelect
              id="default-codex-model"
              label="Default Codex model"
              description="Codex options are loaded from the CLI when available."
              saving={updateSettings.isSaving('defaultCodexModel')}
              value={settings.defaultCodexModel}
              options={withSavedOption(providerOptions?.CODEX.models, settings.defaultCodexModel)}
              onValueChange={(value) => updateSettings.mutate({ defaultCodexModel: value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingSelect
              id="default-claude-effort"
              label="Default Claude effort"
              saving={updateSettings.isSaving('defaultClaudeReasoningEffort')}
              value={settings.defaultClaudeReasoningEffort ?? PROVIDER_DEFAULT_EFFORT}
              options={effortOptions(
                providerOptions?.CLAUDE.efforts,
                settings.defaultClaudeReasoningEffort
              )}
              onValueChange={(value) =>
                updateSettings.mutate({ defaultClaudeReasoningEffort: toEffort(value) })
              }
            />
            <SettingSelect
              id="default-codex-effort"
              label="Default Codex effort"
              saving={updateSettings.isSaving('defaultCodexReasoningEffort')}
              value={settings.defaultCodexReasoningEffort ?? PROVIDER_DEFAULT_EFFORT}
              options={effortOptions(
                providerOptions?.CODEX.efforts,
                settings.defaultCodexReasoningEffort
              )}
              onValueChange={(value) =>
                updateSettings.mutate({ defaultCodexReasoningEffort: toEffort(value) })
              }
            />
          </div>
          <SettingSelect
            id="workspace-permissions"
            label="Default permissions for new workspaces"
            description={NATIVE_PERMISSION_DESCRIPTION}
            saving={updateSettings.isSaving('defaultWorkspacePermissions')}
            value={settings.defaultWorkspacePermissions}
            options={NATIVE_PERMISSION_OPTIONS}
            onValueChange={(value) => updateSettings.mutate({ defaultWorkspacePermissions: value })}
          />
          <SettingSelect
            id="automation-permissions"
            label="Automation permissions"
            description="Scheduled and event automations use these permissions for future runs. Auto review is the default."
            saving={updateSettings.isSaving('automationPermissions')}
            value={settings.automationPermissions}
            options={NATIVE_PERMISSION_OPTIONS}
            onValueChange={(value) => updateSettings.mutate({ automationPermissions: value })}
          />
        </>
      )}
    </SettingsSection>
  );
}
