import { useState } from 'react';
import { Loading } from '@/client/components/loading';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { slackConnectInputSchema, type SlackConnectionSummary } from '@/shared/slack-connection';
import { SlackAppTokenControls } from './slack-app-token';

/** The Slack operation in flight; the row or form that started it shows the spinner. */
export type SlackPendingOperation =
  | { kind: 'connect' }
  | {
      kind: 'test' | 'disconnect' | 'setAppToken' | 'clearAppToken';
      connectionId: string;
    };

type OperationResult = { succeeded: boolean; error?: string };

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
  onDisconnect: (id: string) => Promise<OperationResult>;
  /** The app-level token being entered for one connection; never prefilled. */
  appTokenDraft?: { connectionId: string; token: string };
  onAppTokenEdit: (connectionId: string | undefined) => void;
  onAppTokenChange: (value: string) => void;
  onSaveAppToken: () => void;
  onClearAppToken: (id: string) => Promise<OperationResult>;
}

export function SlackConnectionsView(props: SlackConnectionsViewProps) {
  const [disconnectId, setDisconnectId] = useState<string>();
  const [disconnectError, setDisconnectError] = useState<string>();
  const [removeAppId, setRemoveAppId] = useState<string>();
  const [removeAppError, setRemoveAppError] = useState<string>();
  const busy = props.pending !== undefined;
  const disconnecting = props.connections?.find((connection) => connection.id === disconnectId);
  const isPending = (kind: SlackPendingOperation['kind'], connectionId?: string) =>
    props.pending?.kind === kind &&
    (props.pending.kind === 'connect' || props.pending.connectionId === connectionId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack</CardTitle>
        <CardDescription>
          Connect a Slack workspace with a bot token. Receiving Slack events also needs an app-level
          token from the same Slack app. Tokens are encrypted on this Factory Factory server.
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
            {connection.hasCredentials && (
              <SlackAppTokenControls
                connection={connection}
                draft={
                  props.appTokenDraft?.connectionId === connection.id
                    ? props.appTokenDraft.token
                    : undefined
                }
                busy={busy || !!props.loading}
                saving={isPending('setAppToken', connection.id)}
                onEdit={() => props.onAppTokenEdit(connection.id)}
                onCancel={() => props.onAppTokenEdit(undefined)}
                onDraftChange={props.onAppTokenChange}
                onSave={props.onSaveAppToken}
                onRemove={() => {
                  setRemoveAppError(undefined);
                  setRemoveAppId(connection.id);
                }}
              />
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
          description={`Remove the saved bot token${disconnecting?.hasAppToken ? ' and app-level token' : ''} from Factory Factory. This does not revoke the token or change your Slack app. You can reconnect with a valid token.${disconnectError ? ` ${disconnectError}` : ''}`}
          confirmText="Disconnect"
          pendingText="Disconnecting…"
          variant="destructive"
          isPending={busy}
          onConfirm={() => {
            if (disconnectId) {
              setDisconnectError(undefined);
              confirmOperation(props.onDisconnect(disconnectId), {
                close: () => setDisconnectId(undefined),
                fail: setDisconnectError,
                fallback: "Couldn't disconnect Slack. Try again.",
              });
            }
          }}
        />
        <ConfirmDialog
          open={!!removeAppId}
          onOpenChange={(open) => {
            if (!open) {
              setRemoveAppId(undefined);
            }
          }}
          title="Remove app-level token?"
          description={`Remove the saved app-level token from Factory Factory. The bot token stays connected. This does not revoke the token in Slack.${removeAppError ? ` ${removeAppError}` : ''}`}
          confirmText="Remove"
          pendingText="Removing…"
          variant="destructive"
          isPending={busy}
          onConfirm={() => {
            if (removeAppId) {
              setRemoveAppError(undefined);
              confirmOperation(props.onClearAppToken(removeAppId), {
                close: () => setRemoveAppId(undefined),
                fail: setRemoveAppError,
                fallback: "Couldn't remove the app-level token. Try again.",
              });
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

/** Operations confirmed in a dialog, which reports their failure itself. */
const dialogOperations = new Set<SlackPendingOperation['kind']>(['disconnect', 'clearAppToken']);

/** Closes a confirmation on success; keeps it open with the error otherwise. */
function confirmOperation(
  operation: Promise<OperationResult>,
  handlers: { close: () => void; fail: (error: string) => void; fallback: string }
) {
  void operation.then(
    (result) => {
      if (result.succeeded) {
        handlers.close();
      } else {
        handlers.fail(result.error ?? handlers.fallback);
      }
    },
    () => handlers.fail(handlers.fallback)
  );
}

export function SlackSettings() {
  const connections = trpc.slack.list.useQuery();
  const connect = trpc.slack.connect.useMutation({ gcTime: 0, meta: { errorToast: false } });
  const test = trpc.slack.test.useMutation({ meta: { errorToast: false } });
  const disconnect = trpc.slack.disconnect.useMutation({ meta: { errorToast: false } });
  const setAppToken = trpc.slack.setAppToken.useMutation({
    gcTime: 0,
    meta: { errorToast: false },
  });
  const clearAppToken = trpc.slack.clearAppToken.useMutation({ meta: { errorToast: false } });
  const [token, setToken] = useState('');
  const [appTokenDraft, setAppTokenDraft] = useState<{ connectionId: string; token: string }>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // Spans the mutation and the list refresh after it, so controls stay
  // disabled until the refreshed connections are on screen.
  const [pending, setPending] = useState<SlackPendingOperation>();

  async function refresh() {
    const failed = await connections.refetch().then(
      (refreshed) => !!refreshed.error,
      () => true
    );
    if (failed) {
      setError((current) => current ?? 'Connections could not be refreshed. Reload Settings.');
    }
  }

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
      // Confirmation dialogs show their own failure; others use the page alert.
      if (!dialogOperations.has(target.kind)) {
        setError(operationError);
      }
    } finally {
      await refresh();
      setPending(undefined);
      // Drop the submitted tokens from the mutation state.
      connect.reset();
      setAppToken.reset();
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
          if (appTokenDraft?.connectionId === id) {
            setAppTokenDraft(undefined);
          }
          return 'Slack credentials removed.';
        });
      }}
      appTokenDraft={appTokenDraft}
      onAppTokenEdit={(connectionId) =>
        setAppTokenDraft(connectionId ? { connectionId, token: '' } : undefined)
      }
      onAppTokenChange={(value) =>
        setAppTokenDraft((current) => (current ? { ...current, token: value } : current))
      }
      onSaveAppToken={() => {
        const draft = appTokenDraft;
        if (!draft) {
          return;
        }
        void perform({ kind: 'setAppToken', connectionId: draft.connectionId }, async () => {
          const saved = await setAppToken.mutateAsync({
            connectionId: draft.connectionId,
            appToken: draft.token.trim(),
          });
          setAppTokenDraft(undefined);
          return `Saved the app-level token for ${saved.name}.`;
        });
      }}
      onClearAppToken={(id) => {
        return perform({ kind: 'clearAppToken', connectionId: id }, async () => {
          await clearAppToken.mutateAsync({ connectionId: id });
          return 'App-level token removed.';
        });
      }}
    />
  );
}
