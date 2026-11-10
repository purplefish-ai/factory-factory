import { useState } from 'react';
import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { slackConnectInputSchema, type SlackConnectionSummary } from '@/shared/slack-connection';

/** The Slack operation in flight; the row or form that started it shows the spinner. */
export type SlackPendingOperation =
  | { kind: 'connect' }
  | { kind: 'test' | 'disconnect'; connectionId: string };

interface SlackConnectionsViewProps {
  connections?: readonly SlackConnectionSummary[];
  loading?: boolean;
  pending?: SlackPendingOperation;
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
  const busy = props.pending !== undefined;
  const isPending = (kind: SlackPendingOperation['kind'], connectionId?: string) =>
    props.pending?.kind === kind &&
    (props.pending.kind === 'connect' || props.pending.connectionId === connectionId);
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
        {props.loading && <Loading size="compact" message="Loading Slack connections…" />}
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
              <p className="break-words text-xs text-muted-foreground">
                {connection.hasCredentials ? 'Token saved' : 'Disconnected'} ·{' '}
                {connection.workspaceId}
              </p>
            </div>
            {connection.hasCredentials && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  pending={isPending('test', connection.id)}
                  pendingLabel="Testing…"
                  onClick={() => props.onTest(connection.id)}
                >
                  Test connection
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
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
              disabled={busy || props.loading}
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
              busy ||
              props.loading ||
              !slackConnectInputSchema.safeParse({ botToken: props.token }).success
            }
            pending={isPending('connect')}
            pendingLabel="Connecting…"
          >
            Connect Slack
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Saving credentials does not start event listeners or automations.
        </p>
        <ConfirmDialog
          open={!!disconnectId}
          onOpenChange={(open) => {
            if (!open) {
              setDisconnectId(undefined);
            }
          }}
          title="Disconnect Slack?"
          description={`Remove the saved bot token from Factory Factory. This does not revoke the token or change your Slack app. You can reconnect with a valid token.${disconnectError ? ` ${disconnectError}` : ''}`}
          confirmText="Disconnect"
          pendingText="Disconnecting…"
          variant="destructive"
          isPending={busy}
          onConfirm={() => {
            if (disconnectId) {
              setDisconnectError(undefined);
              void props.onDisconnect(disconnectId).then(
                (result) => {
                  if (result.succeeded) {
                    setDisconnectId(undefined);
                  } else {
                    setDisconnectError(result.error ?? "Couldn't disconnect Slack. Try again.");
                  }
                },
                () => setDisconnectError("Couldn't disconnect Slack. Try again.")
              );
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

export function SlackSettings() {
  const connections = trpc.slack.list.useQuery();
  const connect = trpc.slack.connect.useMutation({ gcTime: 0, meta: { errorToast: false } });
  const test = trpc.slack.test.useMutation({ meta: { errorToast: false } });
  const disconnect = trpc.slack.disconnect.useMutation({ meta: { errorToast: false } });
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // Spans the mutation and the list refresh after it, so controls stay
  // disabled until the refreshed connections are on screen.
  const [pending, setPending] = useState<SlackPendingOperation>();

  async function perform(target: SlackPendingOperation, operation: () => Promise<string>) {
    setPending(target);
    setError(undefined);
    setNotice(undefined);
    let succeeded = false;
    let operationError: string | undefined;
    try {
      setNotice(await operation());
      succeeded = true;
    } catch (error) {
      operationError = error instanceof Error ? error.message : "Couldn't update Slack connection.";
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
      setPending(undefined);
      connect.reset();
    }
    return { succeeded, ...(operationError ? { error: operationError } : {}) };
  }

  return (
    <SlackConnectionsView
      connections={connections.data}
      loading={connections.isLoading}
      pending={pending}
      error={error ?? connections.error?.message}
      notice={notice}
      token={token}
      onTokenChange={setToken}
      onConnect={() => {
        void perform({ kind: 'connect' }, async () => {
          const saved = await connect.mutateAsync({ botToken: token.trim() });
          setToken('');
          return `Connected to ${saved.name}.`;
        });
      }}
      onTest={(id) => {
        void perform({ kind: 'test', connectionId: id }, async () => {
          const result = await test.mutateAsync({ id });
          return `Connected to ${result.workspaceName}.`;
        });
      }}
      onDisconnect={(id) => {
        return perform({ kind: 'disconnect', connectionId: id }, async () => {
          await disconnect.mutateAsync({ id });
          return 'Slack credentials removed.';
        });
      }}
    />
  );
}
