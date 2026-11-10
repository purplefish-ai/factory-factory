import { useState } from 'react';
import { toast } from 'sonner';
import { useUpdateUserSettings, useUserSettings } from '@/client/lib/user-settings-queries';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { DEFAULT_TICKET_DISPATCH_PROMPT } from '@/shared/issue-start-prompt';
import { SettingField, SettingsSection } from './settings-section';

export function TicketDispatchSettingsSection() {
  const settingsQuery = useUserSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const update = useUpdateUserSettings();

  return (
    <SettingsSection
      title="Ticket dispatch prompt"
      description="Instructions for starting GitHub and Linear tickets. The ticket link is appended automatically."
      query={settingsQuery}
      errorTitle="Couldn't load ticket dispatch settings"
    >
      {(settings) => {
        const saved = settings.ticketDispatchPrompt ?? DEFAULT_TICKET_DISPATCH_PROMPT;
        const value = draft ?? saved;
        const save = (ticketDispatchPrompt: string | null) =>
          update.mutate(
            { ticketDispatchPrompt },
            {
              onSuccess: () => {
                setDraft(null);
                toast.success('Ticket dispatch prompt saved.');
              },
            }
          );
        return (
          <>
            <SettingField
              label="Prompt"
              htmlFor="ticket-dispatch-prompt"
              saving={update.isSaving('ticketDispatchPrompt')}
            >
              <Textarea
                id="ticket-dispatch-prompt"
                rows={6}
                maxLength={20_000}
                value={value}
                onChange={(event) => setDraft(event.target.value)}
                disabled={update.isPending}
              />
            </SettingField>
            <div className="flex gap-2">
              <Button
                disabled={update.isPending || !value.trim() || value === saved}
                onClick={() => save(value.trim())}
              >
                {update.isPending ? 'Saving…' : 'Save prompt'}
              </Button>
              <Button
                variant="outline"
                disabled={update.isPending || settings.ticketDispatchPrompt == null}
                onClick={() => {
                  setDraft(null);
                  save(null);
                }}
              >
                Reset to default
              </Button>
            </div>
          </>
        );
      }}
    </SettingsSection>
  );
}
