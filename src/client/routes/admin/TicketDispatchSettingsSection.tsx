import { useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DEFAULT_TICKET_DISPATCH_PROMPT } from '@/shared/issue-start-prompt';

export function TicketDispatchSettingsSection() {
  const { data: settings, isLoading, isError } = trpc.userSettings.get.useQuery();
  const [draft, setDraft] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const update = trpc.userSettings.update.useMutation({
    onSuccess: (result) => {
      utils.userSettings.get.setData(undefined, result);
      setDraft(null);
      toast.success('Ticket dispatch prompt saved.');
    },
    onError: (error) => toast.error(`Couldn't save ticket dispatch prompt. ${error.message}`),
  });
  const saved = settings?.ticketDispatchPrompt ?? DEFAULT_TICKET_DISPATCH_PROMPT;
  const value = draft ?? saved;
  const disabled = isLoading || !settings || update.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ticket dispatch prompt</CardTitle>
        <CardDescription>
          Instructions for starting GitHub and Linear tickets. The ticket link is appended
          automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError && !settings ? <p role="alert">Couldn't load ticket dispatch settings.</p> : null}
        <Label htmlFor="ticket-dispatch-prompt">Prompt</Label>
        <Textarea
          id="ticket-dispatch-prompt"
          rows={6}
          maxLength={20_000}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
        />
        <div className="flex gap-2">
          <Button
            disabled={disabled || !value.trim() || value === saved}
            onClick={() => update.mutate({ ticketDispatchPrompt: value.trim() })}
          >
            {update.isPending ? 'Saving…' : 'Save prompt'}
          </Button>
          <Button
            variant="outline"
            disabled={disabled || settings?.ticketDispatchPrompt == null}
            onClick={() => update.mutate({ ticketDispatchPrompt: null })}
          >
            Reset to default
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
