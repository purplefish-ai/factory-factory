import { useUpdateUserSettings, useUserSettings } from '@/client/lib/user-settings-queries';
import { Switch } from '@/components/ui/switch';
import { SettingRow, SettingsSection } from './settings-section';

export function ChildWorkspaceSettingsSection() {
  const settingsQuery = useUserSettings();
  const updateSettings = useUpdateUserSettings();

  return (
    <SettingsSection
      title="Child workspaces"
      description="Delegate work to separate child workspaces"
      query={settingsQuery}
      errorTitle="Couldn't load child workspace settings"
    >
      {(settings) => (
        <SettingRow
          label="Enable child workspaces"
          htmlFor="child-workspaces-toggle"
          description="Show child workspace controls and let agents delegate work. Existing workspaces are preserved when disabled."
          saving={updateSettings.isSaving('childWorkspacesEnabled')}
        >
          <Switch
            id="child-workspaces-toggle"
            checked={settings.childWorkspacesEnabled}
            onCheckedChange={(checked) =>
              updateSettings.mutate({ childWorkspacesEnabled: checked })
            }
          />
        </SettingRow>
      )}
    </SettingsSection>
  );
}
