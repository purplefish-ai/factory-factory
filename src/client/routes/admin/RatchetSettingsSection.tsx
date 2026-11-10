import { ArrowsClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { toast } from 'sonner';
import { RatchetWrenchIcon } from '@/client/features/workspace';
import { trpc } from '@/client/lib/trpc';
import { useUpdateUserSettings, useUserSettings } from '@/client/lib/user-settings-queries';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SettingRow, SettingSelect, SettingsSection } from './settings-section';

const REVIEW_TRIGGER_OPTIONS = [
  { value: 'CHANGES_REQUESTED', label: 'Changes requested and unresolved threads' },
  { value: 'ALL_REVIEW_FEEDBACK', label: 'All review feedback' },
] as const;

export function RatchetSettingsSection() {
  const settingsQuery = useUserSettings();
  const updateSettings = useUpdateUserSettings();

  const triggerRatchetCheck = trpc.admin.triggerRatchetCheck.useMutation({
    onSuccess: (result) => {
      toast.success(
        `PR check completed: ${result.checked} checked, ${result.stateChanges} state changes, ${result.actionsTriggered} updates queued`
      );
    },
    onError: (error) => {
      toast.error(`Couldn't check PR updates. ${error.message}`);
    },
  });

  return (
    <SettingsSection
      title="PR updates"
      icon={<RatchetWrenchIcon enabled className="w-5 h-5" iconClassName="w-3.5 h-3.5" />}
      description="Queue CI, review and merge-conflict updates in the main conversation for its next turn"
      query={settingsQuery}
      errorTitle="Couldn't load PR update settings"
    >
      {(settings) => (
        <>
          <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
            <p className="text-sm text-muted-foreground">
              When a workspace has an open pull request, Factory Factory can automatically:
            </p>
            <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5 ml-2">
              <li>Queue failing CI checks for the next turn</li>
              <li>Queue actionable code review feedback</li>
            </ul>
          </div>

          <SettingRow
            label="Default for new workspaces"
            htmlFor="ratchet-enabled"
            description="Enable PR updates for workspaces created from GitHub issues"
            saving={updateSettings.isSaving('ratchetEnabled')}
          >
            <Switch
              id="ratchet-enabled"
              checked={settings.ratchetEnabled}
              onCheckedChange={(checked) => updateSettings.mutate({ ratchetEnabled: checked })}
            />
          </SettingRow>

          <SettingSelect
            id="ratchet-review-trigger"
            label="Review feedback trigger"
            description="All review feedback also lets top-level commented review summaries queue updates. Ordinary PR conversation comments do not queue updates."
            saving={updateSettings.isSaving('ratchetReviewTriggerMode')}
            value={settings.ratchetReviewTriggerMode}
            options={REVIEW_TRIGGER_OPTIONS}
            onValueChange={(value) => updateSettings.mutate({ ratchetReviewTriggerMode: value })}
          />

          <SettingRow
            label="Reply to PR comments"
            htmlFor="ratchet-reply-to-pr-comments"
            description="Allow the main session to reply on review threads when it addresses feedback"
            saving={updateSettings.isSaving('ratchetReplyToPrComments')}
          >
            <Switch
              id="ratchet-reply-to-pr-comments"
              checked={settings.ratchetReplyToPrComments}
              onCheckedChange={(checked) =>
                updateSettings.mutate({ ratchetReplyToPrComments: checked })
              }
            />
          </SettingRow>

          <SettingRow
            className="border-t pt-4"
            label="Manual check"
            description="Check monitored PRs and queue actionable updates"
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => triggerRatchetCheck.mutate()}
              pending={triggerRatchetCheck.isPending}
              pendingLabel="Checking…"
            >
              <ArrowsClockwiseIcon />
              Check all PRs now
            </Button>
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}
