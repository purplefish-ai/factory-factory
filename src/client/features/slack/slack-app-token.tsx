import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { slackAppTokenSchema, type SlackConnectionSummary } from '@/shared/slack-connection';

interface SlackAppTokenControlsProps {
  connection: SlackConnectionSummary;
  /** The token being typed; undefined while the entry form is closed. */
  draft?: string;
  busy: boolean;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onRemove: () => void;
}

/** Socket Mode app-level token status and masked entry for one connected workspace. */
export function SlackAppTokenControls(props: SlackAppTokenControlsProps) {
  const { connection } = props;
  const inputId = `slack-app-token-${connection.id}`;
  const helpId = `${inputId}-help`;
  return (
    <div className="basis-full space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {connection.hasAppToken
            ? `App-level token saved${connection.appId ? ` · App ${connection.appId}` : ''}`
            : 'No app-level token'}
        </p>
        {props.draft === undefined && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={props.busy} onClick={props.onEdit}>
              {connection.hasAppToken ? 'Replace app token' : 'Add app token'}
            </Button>
            {connection.hasAppToken && (
              <Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onRemove}>
                Remove app token
              </Button>
            )}
          </div>
        )}
      </div>
      {props.draft !== undefined && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSave();
          }}
        >
          <Label htmlFor={inputId}>App-level token</Label>
          <Input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="xapp-…"
            value={props.draft}
            disabled={props.busy}
            onChange={(event) => props.onDraftChange(event.target.value)}
            aria-describedby={helpId}
          />
          <p id={helpId} className="text-xs text-muted-foreground">
            Turn on Socket Mode in the same Slack app as the bot token, then create an app-level
            token with the connections:write scope under Basic Information. Slack events will arrive
            through this token once event intake is available.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={props.busy || !slackAppTokenSchema.safeParse(props.draft).success}
              pending={props.saving}
              pendingLabel="Saving…"
            >
              Save app token
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.busy}
              onClick={props.onCancel}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
