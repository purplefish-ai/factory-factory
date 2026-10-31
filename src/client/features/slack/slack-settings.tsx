import { useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { slackConnectInputSchema, type SlackConnectionSummary } from '@/shared/slack-connection';

interface SlackConnectionsViewProps {
  connections?: readonly SlackConnectionSummary[];
  loading?: boolean;
  busy?: boolean;
  error?: string;
  notice?: string;
  token: string;
  onTokenChange: (value: string) => void;
  onConnect: () => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => Promise<{ succeeded: boolean; error?: string }>;
}

export function SlackConnectionsView(props: SlackConnectionsViewProps) {
  const [disconnectId, setDisconnectId] = useState<string>();
  const [disconnectError, setDisconnectError] = useState<string>();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack</CardTitle>
        <CardDescription>
          Connect a Slack workspace with a bot token. Tokens are encrypted on this Factory Factory
          server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading Slack connections…
          </p>
        )}
        {props.error && (
          <p role="alert" className="text-sm text-destructive">
            {props.error}
          </p>
        )}
        {props.notice && (
          <p role="status" className="text-sm">
            {props.notice}
          </p>
        )}
        {props.connections?.map((connection) => (
          <div
            key={connection.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">{connection.name}</p>
              <p className="text-xs text-muted-foreground">
                {connection.hasCredentials ? 'Token saved' : 'Disconnected'} ·{' '}
                {connection.workspaceId}
              </p>
            </div>
            {connection.hasCredentials && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={props.busy}
                  onClick={() => props.onTest(connection.id)}
                >
                  Test connection
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={props.busy}
                  onClick={() => {
                    setDisconnectError(undefined);
                    setDisconnectId(connection.id);
                  }}
                >
                  Disconnect
                </Button>
              </div>
            )}
          </div>
        ))}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            props.onConnect();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="slack-bot-token">Bot token</Label>
            <Input
              id="slack-bot-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="xoxb-…"
              value={props.token}
              disabled={props.busy || props.loading}
              onChange={(event) => props.onTokenChange(event.target.value)}
              aria-describedby="slack-token-help"
            />
            <p id="slack-token-help" className="text-xs text-muted-foreground">
              Find the Bot User OAuth Token in your Slack app’s OAuth &amp; Permissions settings.
              Reconnecting the same workspace replaces its saved token.
              {props.token.trim().startsWith('xoxe.xoxb-') &&
                ' Rotating tokens need manual renewal; automatic refresh is not supported.'}
            </p>
          </div>
          <Button
            type="submit"
            disabled={
              props.busy ||
              props.loading ||
              !slackConnectInputSchema.safeParse({ botToken: props.token }).success
            }
          >
            Connect Slack
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Saving credentials does not start event listeners or agents.
        </p>
        <ConfirmDialog
          open={!!disconnectId}
          onOpenChange={(open) => {
            if (!(props.busy || open)) {
              setDisconnectId(undefined);
            }
          }}
          title="Disconnect Slack?"
          description={`Remove the saved bot token from Factory Factory. This does not revoke the token or change your Slack app.${disconnectError ? ` ${disconnectError}` : ''}`}
          confirmText="Disconnect Slack"
          variant="destructive"
          isPending={props.busy}
          onConfirm={() => {
            if (disconnectId) {
              setDisconnectError(undefined);
              void props.onDisconnect(disconnectId).then(
                (result) => {
                  if (result.succeeded) {
                    setDisconnectId(undefined);
                  } else {
                    setDisconnectError(result.error ?? 'Could not disconnect Slack. Try again.');
                  }
                },
                () => setDisconnectError('Could not disconnect Slack. Try again.')
              );
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

export function SlackSettings() {
  const connections = trpc.slack.list.useQuery(undefined, { retry: false });
  const connect = trpc.slack.connect.useMutation({ gcTime: 0 });
  const test = trpc.slack.test.useMutation();
  const disconnect = trpc.slack.disconnect.useMutation();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function perform(operation: () => Promise<string>) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    let succeeded = false;
    let operationError: string | undefined;
    try {
      setNotice(await operation());
      succeeded = true;
    } catch (error) {
      operationError =
        error instanceof Error ? error.message : 'Could not update Slack connection.';
      setError(operationError);
    } finally {
      try {
        const refreshed = await connections.refetch();
        if (refreshed.error) {
          setError((current) => current ?? 'Connections could not be refreshed. Reload Settings.');
        }
      } catch {
        setError((current) => current ?? 'Connections could not be refreshed. Reload Settings.');
      }
      setBusy(false);
      connect.reset();
    }
    return { succeeded, ...(operationError ? { error: operationError } : {}) };
  }

  return (
    <SlackConnectionsView
      connections={connections.data}
      loading={connections.isLoading}
      busy={busy}
      error={error ?? connections.error?.message}
      notice={notice}
      token={token}
      onTokenChange={setToken}
      onConnect={() => {
        void perform(async () => {
          const saved = await connect.mutateAsync({ botToken: token.trim() });
          setToken('');
          return `Connected to ${saved.name}.`;
        });
      }}
      onTest={(id) => {
        void perform(async () => {
          const result = await test.mutateAsync({ id });
          return `Connected to ${result.workspaceName}.`;
        });
      }}
      onDisconnect={(id) => {
        return perform(async () => {
          await disconnect.mutateAsync({ id });
          return 'Slack credentials removed.';
        });
      }}
    />
  );
}
