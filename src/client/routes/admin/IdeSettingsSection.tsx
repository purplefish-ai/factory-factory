import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import {
  type UserSettingsPatch,
  useUpdateUserSettings,
  useUserSettings,
} from '@/client/lib/user-settings-queries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingField, SettingSelect, SettingsSection } from './settings-section';

const IDE_OPTIONS = [
  { value: 'cursor', label: 'Cursor' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'custom', label: 'Custom' },
] as const;
type IdeOption = (typeof IDE_OPTIONS)[number]['value'];

export function IdeSettingsSection() {
  const settingsQuery = useUserSettings();
  const updateSettings = useUpdateUserSettings();
  // Custom is chosen before its command is saved; until then the saved IDE stays in effect.
  const [isConfiguringCustomIde, setIsConfiguringCustomIde] = useState(false);
  const [commandDraft, setCommandDraft] = useState<string | null>(null);

  const testCommand = trpc.userSettings.testCustomCommand.useMutation({
    onSuccess: () => {
      toast.success('Command executed');
    },
    onError: (error) => {
      toast.error(`Couldn't test the command. ${error.message}`);
    },
  });

  const saveIde = (patch: UserSettingsPatch) =>
    updateSettings.mutate(patch, {
      onSuccess: () => {
        setIsConfiguringCustomIde(false);
        // A saved command replaces the draft; other IDE changes keep unsaved text.
        if (
          patch.customIdeCommand !== undefined &&
          patch.customIdeCommand === commandDraft?.trim()
        ) {
          setCommandDraft(null);
        }
      },
    });

  return (
    <SettingsSection
      title="IDE settings"
      description="Configure your preferred IDE for opening workspaces"
      query={settingsQuery}
      errorTitle="Couldn't load IDE settings"
    >
      {(settings) => {
        const savedCommand = settings.customIdeCommand ?? '';
        const command = commandDraft ?? savedCommand;
        const savedIde =
          IDE_OPTIONS.find((option) => option.value === settings.preferredIde)?.value ?? 'cursor';
        const selectedIde = isConfiguringCustomIde ? 'custom' : savedIde;
        const handleIdeChange = (value: IdeOption) => {
          setIsConfiguringCustomIde(value === 'custom');
          if (value !== 'custom') {
            saveIde({ preferredIde: value });
          } else if (savedCommand.trim()) {
            saveIde({ preferredIde: 'custom', customIdeCommand: savedCommand });
          }
        };
        const handleTestCommand = () => {
          if (!command.trim()) {
            toast.error("Couldn't test the command. Enter a custom command first.");
            return;
          }
          testCommand.mutate({ customCommand: command });
        };
        return (
          <>
            <SettingSelect
              id="ide-select"
              label="Preferred IDE"
              saving={updateSettings.isSaving('preferredIde')}
              value={selectedIde}
              options={IDE_OPTIONS}
              onValueChange={handleIdeChange}
            />

            {selectedIde === 'custom' && (
              <SettingField
                label="Custom command"
                htmlFor="custom-command"
                saving={updateSettings.isSaving('customIdeCommand')}
                description={
                  <>
                    Use <code className="bg-muted px-1 py-0.5 rounded">{'{workspace}'}</code> as a
                    placeholder for the workspace path. Example:{' '}
                    <code className="bg-muted px-1 py-0.5 rounded">
                      code-insiders {'{workspace}'}
                    </code>
                  </>
                }
              >
                <form
                  className="flex flex-col gap-2 sm:flex-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const customIdeCommand = command.trim();
                    if (customIdeCommand) {
                      saveIde({ preferredIde: 'custom', customIdeCommand });
                    }
                  }}
                >
                  <Input
                    id="custom-command"
                    value={command}
                    onChange={(e) => setCommandDraft(e.target.value)}
                    placeholder="code-insiders {workspace}"
                    className="font-mono text-sm flex-1"
                    disabled={updateSettings.isPending}
                  />
                  <Button
                    type="submit"
                    pending={updateSettings.isPending}
                    pendingLabel="Saving…"
                    disabled={!command.trim()}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleTestCommand}
                    pending={testCommand.isPending}
                    pendingLabel="Testing…"
                    disabled={!command.trim()}
                  >
                    Test
                  </Button>
                </form>
              </SettingField>
            )}
          </>
        );
      }}
    </SettingsSection>
  );
}
