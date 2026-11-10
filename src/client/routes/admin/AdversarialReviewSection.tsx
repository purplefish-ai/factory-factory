import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import { ProviderCliWarning } from '@/client/components/provider-cli-warning';
import {
  useProviderOptions,
  useUpdateUserSettings,
  useUserSettings,
} from '@/client/lib/user-settings-queries';
import { Switch } from '@/components/ui/switch';
import { PROVIDER_OPTIONS, withSavedOption } from './provider-model-options';
import { SettingRow, SettingSelect, SettingsSection } from './settings-section';

export function AdversarialReviewSection() {
  const settingsQuery = useUserSettings();
  const { data: providerOptions } = useProviderOptions();
  const updateSettings = useUpdateUserSettings();

  return (
    <SettingsSection
      title="Adversarial review"
      icon={<ShieldWarningIcon className="w-5 h-5" />}
      description="Review an open PR with a different provider/model than the one that built it — e.g. build with Claude, review with Codex."
      query={settingsQuery}
      errorTitle="Couldn't load adversarial review settings"
    >
      {(settings) => {
        const claudeModel = settings.reviewerClaudeModel ?? 'sonnet';
        const codexModel = settings.reviewerCodexModel ?? 'default';
        return (
          <>
            <div className="space-y-3">
              <SettingSelect
                id="reviewer-provider"
                label="Reviewer provider"
                saving={updateSettings.isSaving('reviewerSessionProvider')}
                value={settings.reviewerSessionProvider}
                options={PROVIDER_OPTIONS}
                onValueChange={(value) => updateSettings.mutate({ reviewerSessionProvider: value })}
              />
              <ProviderCliWarning provider={settings.reviewerSessionProvider} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <SettingSelect
                id="reviewer-claude-model"
                label="Claude reviewer model"
                saving={updateSettings.isSaving('reviewerClaudeModel')}
                value={claudeModel}
                options={withSavedOption(providerOptions?.CLAUDE.models, claudeModel)}
                onValueChange={(value) => updateSettings.mutate({ reviewerClaudeModel: value })}
              />
              <SettingSelect
                id="reviewer-codex-model"
                label="Codex reviewer model"
                saving={updateSettings.isSaving('reviewerCodexModel')}
                value={codexModel}
                options={withSavedOption(providerOptions?.CODEX.models, codexModel)}
                onValueChange={(value) => updateSettings.mutate({ reviewerCodexModel: value })}
              />
            </div>

            <SettingRow
              label="Post reviews to GitHub"
              htmlFor="post-review-to-github"
              description="Post the review as a summary plus inline comments on the PR. Off runs the review in-app only."
              saving={updateSettings.isSaving('postReviewToGitHub')}
            >
              <Switch
                id="post-review-to-github"
                checked={settings.postReviewToGitHub}
                onCheckedChange={(checked) =>
                  updateSettings.mutate({ postReviewToGitHub: checked })
                }
              />
            </SettingRow>
          </>
        );
      }}
    </SettingsSection>
  );
}
